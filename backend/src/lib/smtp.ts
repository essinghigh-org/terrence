// Minimal RFC 5321 SMTP client.
//
// Supports plain, STARTTLS, and implicit TLS (SMTPS on port 465) transports
// with PLAIN authentication. Dependency-free: one message at a time, strict
// per-step timeouts, and a hard overall deadline so a misconfigured SMTP
// server can never hang a notification delivery.
//
// Connection rules:
//   port 465: implicit TLS from the first byte
//   any other port: plaintext, upgraded via STARTTLS when the server
//     accepts the upgrade (502/454 responses fall back to plaintext)

import { connect, type Socket } from "bun";

export type SmtpSettings = Readonly<{
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  senderEmail: string;
}>;

export type EmailMessage = Readonly<{
  to: readonly string[];
  subject: string;
  text: string;
}>;

type Response = Readonly<{ code: number; message: string }>;

const STEP_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 30_000;

class SmtpError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "SmtpError";
  }
}

interface Session {
  socket: Socket;
  nextResponse(): Promise<Response>;
  send(line: string): Promise<Response>;
  close(): void;
}

async function createSession(host: string, port: number, tls: boolean): Promise<Session> {
  let buffer = "";
  const pending: Array<(response: Response) => void> = [];
  let closed = false;

  const failWaiting = (error: Error): void => {
    while (pending.length > 0) {
      pending.shift()?.({ code: 0, message: error.message });
    }
  };

  const handlers = {
    data(_sock: Socket, chunk: Uint8Array): void {
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
    error(_sock: Socket, error: Error): void {
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
    nextResponse(): Promise<Response> {
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

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SMTP ${what} timed out`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
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
  const implicitTls = settings.port === 465;
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const step = <T>(promise: Promise<T>, what: string): Promise<T> =>
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

    // STARTTLS on non-465 ports. A 502/454 response means the server does
    // not support it; continue in plaintext in that case.
    if (!implicitTls) {
      const startTls = await step(session.send("STARTTLS"), "STARTTLS");
      if (startTls.code === 220) {
        (session.socket as unknown as { upgradeTLS?(options?: Record<string, never>): boolean }).upgradeTLS?.({});
        const tlsEhlo = await step(session.send("EHLO terrence.local"), "EHLO after STARTTLS");
        if (tlsEhlo.code !== 250) {
          throw new SmtpError(`EHLO after STARTTLS rejected: ${tlsEhlo.code} ${tlsEhlo.message}`, tlsEhlo.code);
        }
      }
    }

    if (settings.username !== null && settings.username !== "") {
      const authLine = `AUTH PLAIN ${Buffer.from(`\0${settings.username}\0${settings.password ?? ""}`).toString("base64")}`;
      const auth = await step(session.send(authLine), "AUTH");
      if (auth.code !== 235) {
        throw new SmtpError(`AUTH rejected: ${auth.code} ${auth.message}`, auth.code);
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

    const headers = [
      `From: ${settings.senderEmail}`,
      `To: ${message.to.join(", ")}`,
      `Subject: ${message.subject.replace(/[\r\n]/g, " ")}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      // SMTP requires CRLF line endings; normalize any bare LF in the body.
      message.text.replace(/\r?\n/g, "\r\n"),
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
