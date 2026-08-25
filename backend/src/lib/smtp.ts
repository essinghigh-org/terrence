// Minimal RFC 5321 SMTP client.
//
// Supports plain, STARTTLS, and implicit TLS (SMTPS on port 465) transports
// with PLAIN or LOGIN authentication. Dependency-free: one message at a time, strict
// per-step timeouts, and a hard overall deadline so a misconfigured SMTP
// server can never hang a notification delivery.
//
// Connection rules:
//   port 465: implicit TLS from the first byte
//   any other port: plaintext, upgraded via STARTTLS when the server
//     accepts the upgrade; known unsupported replies fall back to plaintext

import { connect, type Socket } from "bun";

export type SmtpSettings = Readonly<{
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  senderEmail: string;
  auth?: "none" | "plain" | "login" | null;
}>;

export type EmailMessage = Readonly<{
  to: readonly string[];
  subject: string;
  text: string;
  html?: string;
}>;

type Response = Readonly<{ code: number; message: string }>;

const STEP_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 30_000;

function validateMailbox(value: string, label: string): void {
  if (value === "" || value.trim() !== value || /[\s<> ,\r\n\u0000-\u001f\u007f]/.test(value) || !value.includes("@")) {
    throw new SmtpError(`Invalid SMTP ${label}`, 0);
  }
}

/** Encode UTF-8 MIME text without relying on an SMTP 8BITMIME extension. */
function quotedPrintable(value: string): string {
  const lines = value.replace(/\r?\n/g, "\r\n").split("\r\n");
  return lines.map((line): string => {
    const bytes = Buffer.from(line, "utf8");
    let encoded = "";
    let lineLength = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index] ?? 0;
      const atLineEnd = index === bytes.length - 1;
      const safe = (byte >= 33 && byte <= 60) || (byte >= 62 && byte <= 126) || ((byte === 32 || byte === 9) && !atLineEnd);
      const token = safe ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      if (lineLength + token.length > 75) {
        encoded += "=\r\n";
        lineLength = 0;
      }
      encoded += token;
      lineLength += token.length;
    }
    return encoded;
  }).join("\r\n");
}

class SmtpError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = "SmtpError";
  }
}

type Session = {
  socket: Socket;
  nextResponse(): Promise<Response>;
  send(line: string): Promise<Response>;
  close(): void;
}

async function createSession(host: string, port: number, tls: boolean): Promise<Session> {
  let buffer = "";
  const pending: ((response: Response) => void)[] = [];
  let closed = false;

  const failWaiting = (error: Readonly<Error>): void => {
    while (pending.length > 0) {
      pending.shift()?.({ code: 0, message: error.message });
    }
  };

  const handlers = {
    data(_sock: unknown, chunk: Readonly<{ toString(): string }>): void {
      buffer += chunk.toString();
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        // A response is complete when the final line carries a space
        // after the code; intermediate multiline lines carry a dash.
        if (line.length >= 3 && (line.length === 3 || line[3] === " ")) {
          const code = Number.parseInt(line.slice(0, 3), 10);
          const message = line.length > 4 ? line.slice(4) : "";
          pending.shift()?.({ code, message });
        }
      }
    },
    error(_sock: unknown, error: Readonly<{ message: string }>): void {
      failWaiting(new Error(`SMTP connection error: ${error.message}`));
    },
    close(): void {
      failWaiting(new Error("SMTP connection closed"));
    },
  };

  const socket = tls
    ? await connect({ hostname: host, port, tls: { rejectUnauthorized: true }, socket: handlers })
    : await connect({ hostname: host, port, socket: handlers });

  return {
    socket,
    async nextResponse(): Promise<Response> {
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    async send(line: string): Promise<Response> {
      const responsePromise = new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
      socket.write(`${line}\r\n`);
      return responsePromise;
    },
    close(): void {
      if (!closed) {
        closed = true;
        try {
          socket.end();
        } catch {
          // already closed
        }
      }
    },
  };
}

async function withTimeout<T>(promise: Readonly<Promise<T>>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`SMTP ${what} timed out`)); }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Send a single email through the configured SMTP server.
 *
 * Throws SmtpError on any protocol or transport failure. The caller decides
 * how to record the failed delivery.
 */
export async function sendEmail(settings: SmtpSettings, message: EmailMessage): Promise<void> {
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    throw new SmtpError("Invalid SMTP port", 0);
  }
  if (settings.host === "" || settings.host.trim() !== settings.host || /[\r\n\u0000-\u001f\u007f]/.test(settings.host)) {
    throw new SmtpError("Invalid SMTP host", 0);
  }
  validateMailbox(settings.senderEmail, "sender address");
  if (message.to.length === 0) throw new SmtpError("SMTP message has no recipients", 0);
  for (const recipient of message.to) validateMailbox(recipient, "recipient address");

  const implicitTls = settings.port === 465;
  const authMode = settings.auth ?? (settings.username === null || settings.username === "" ? "none" : "plain");
  if (authMode !== "none" && authMode !== "plain" && authMode !== "login") {
    throw new SmtpError(`Unsupported SMTP authentication mode: ${String(authMode)}`, 0);
  }
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const step = async <T>(promise: Readonly<Promise<T>>, what: string): Promise<T> =>
    withTimeout(promise, Math.min(STEP_TIMEOUT_MS, Math.max(1, deadline - Date.now())), what);

  const session = await step(createSession(settings.host, settings.port, implicitTls), "connect");
  try {
    const greeting = await step(session.nextResponse(), "greeting");
    if (greeting.code !== 220) {
      throw new SmtpError(`Unexpected greeting: ${greeting.code} ${greeting.message}`, greeting.code);
    }

    const ehlo = await step(session.send("EHLO terrence.local"), "EHLO");
    if (ehlo.code !== 250) {
      throw new SmtpError(`EHLO rejected: ${ehlo.code} ${ehlo.message}`, ehlo.code);
    }

    // STARTTLS on non-465 ports. Only known unsupported replies continue in
    // plaintext; other failures must not silently downgrade delivery.
    if (!implicitTls) {
      const startTls = await step(session.send("STARTTLS"), "STARTTLS");
      if (startTls.code === 220) {
        (session.socket as unknown as { upgradeTLS?(options?: Readonly<Record<string, never>>): boolean }).upgradeTLS?.({});
        const tlsEhlo = await step(session.send("EHLO terrence.local"), "EHLO after STARTTLS");
        if (tlsEhlo.code !== 250) {
          throw new SmtpError(`EHLO after STARTTLS rejected: ${tlsEhlo.code} ${tlsEhlo.message}`, tlsEhlo.code);
        }
      } else if (![500, 502, 504].includes(startTls.code)) {
        throw new SmtpError(`STARTTLS rejected: ${startTls.code} ${startTls.message}`, startTls.code);
      }
    }

    if (authMode !== "none" && settings.username !== null && settings.username !== "") {
      if (authMode === "plain") {
        const authLine = `AUTH PLAIN ${Buffer.from(`\0${settings.username}\0${settings.password ?? ""}`).toString("base64")}`;
        const auth = await step(session.send(authLine), "AUTH");
        if (auth.code !== 235) {
          throw new SmtpError(`AUTH rejected: ${auth.code} ${auth.message}`, auth.code);
        }
      } else {
        const auth = await step(session.send("AUTH LOGIN"), "AUTH LOGIN");
        if (auth.code !== 334) throw new SmtpError(`AUTH LOGIN rejected: ${auth.code} ${auth.message}`, auth.code);
        const username = await step(session.send(Buffer.from(settings.username).toString("base64")), "AUTH LOGIN username");
        if (username.code !== 334) throw new SmtpError(`AUTH LOGIN username rejected: ${username.code} ${username.message}`, username.code);
        const password = await step(session.send(Buffer.from(settings.password ?? "").toString("base64")), "AUTH LOGIN password");
        if (password.code !== 235) throw new SmtpError(`AUTH LOGIN rejected: ${password.code} ${password.message}`, password.code);
      }
    }

    const mail = await step(session.send(`MAIL FROM:<${settings.senderEmail}>`), "MAIL FROM");
    if (mail.code !== 250) {
      throw new SmtpError(`MAIL FROM rejected: ${mail.code} ${mail.message}`, mail.code);
    }
    for (const recipient of message.to) {
      const rcpt = await step(session.send(`RCPT TO:<${recipient}>`), "RCPT TO");
      if (rcpt.code !== 250 && rcpt.code !== 251) {
        throw new SmtpError(`RCPT TO rejected for ${recipient}: ${rcpt.code} ${rcpt.message}`, rcpt.code);
      }
    }

    const data = await step(session.send("DATA"), "DATA");
    if (data.code !== 354) {
      throw new SmtpError(`DATA rejected: ${data.code} ${data.message}`, data.code);
    }

    // Entity headers (Content-Type, Content-Transfer-Encoding) belong ABOVE
    // the blank line that separates headers from body; anything below it is
    // rendered as literal body text by the receiving MUA.
    const plainText = message.text.replace(/\r?\n/g, "\r\n");
    const boundary = `=_terrence_${crypto.randomUUID()}`;
    const encodedText = quotedPrintable(plainText);
    const entityBody = message.html === undefined
      ? encodedText
      : [
          `--${boundary}`,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          encodedText,
          `--${boundary}`,
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          quotedPrintable(message.html.replace(/\r?\n/g, "\r\n")),
          `--${boundary}--`,
          "",
        ].join("\r\n");
    const headers = [
      `From: ${settings.senderEmail}`,
      `To: ${message.to.join(", ")}`,
      `Subject: ${message.subject.replace(/[\u0000-\u001f\u007f]/g, " ")}`,
      "MIME-Version: 1.0",
      message.html === undefined
        ? "Content-Type: text/plain; charset=utf-8"
        : `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ...(message.html === undefined ? ["Content-Transfer-Encoding: quoted-printable"] : []),
      "",
      entityBody,
    ].join("\r\n");
    // Dot-stuffing: a line that starts with "." gets an extra leading ".".
    const stuffed = headers.replace(/^\./gm, "..");
    const terminated = stuffed.endsWith("\r\n") ? `${stuffed}.` : `${stuffed}\r\n.`;

    const body = await step(session.send(terminated), "message body");
    if (body.code !== 250) {
      throw new SmtpError(`Message rejected: ${body.code} ${body.message}`, body.code);
    }

    await step(session.send("QUIT"), "QUIT");
  } finally {
    session.close();
  }
}
