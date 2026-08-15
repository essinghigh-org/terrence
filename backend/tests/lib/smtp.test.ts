import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sendEmail, type SmtpSettings } from "../../src/lib/smtp";

/**
 * Minimal scriptable SMTP server for tests. Speaks just enough of the
 * protocol: greeting, EHLO (advertising AUTH PLAIN), optional STARTTLS
 * refusal, AUTH PLAIN, MAIL/RCPT/DATA, QUIT. Captures the raw message.
 */
function createFakeSmtpServer(options: Readonly<{ rejectRcpt?: string }> = {}) {
  let received: Array<string> = [];
  let inData = false;

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket): void {
        socket.write("220 test-smtp ready\r\n");
      },
      data(socket, chunk): void {
        const text = chunk.toString();
        for (const rawLine of text.split("\r\n")) {
          if (rawLine === "") continue;
          const line = rawLine.trim();
          if (inData) {
            if (line === ".") {
              socket.write("250 accepted\r\n");
              inData = false;
            } else {
              received.push(line);
            }
            continue;
          }
          if (line.startsWith("EHLO")) {
            socket.write("250-test-smtp\r\n250 AUTH PLAIN\r\n");
          } else if (line === "STARTTLS") {
            socket.write("502 STARTTLS not supported\r\n");
          } else if (line.startsWith("AUTH PLAIN")) {
            socket.write("235 authenticated\r\n");
          } else if (line.startsWith("MAIL FROM")) {
            socket.write("250 ok\r\n");
          } else if (line.startsWith("RCPT TO")) {
            const recipient = line.slice("RCPT TO:<".length, -1);
            if (options.rejectRcpt === recipient) {
              socket.write("550 no such user\r\n");
            } else {
              socket.write("250 ok\r\n");
            }
          } else if (line === "DATA") {
            socket.write("354 end with .\r\n");
            inData = true;
          } else if (line === "QUIT") {
            socket.write("221 bye\r\n");
          }
        }
      },
    },
  });

  return {
    port: server.port,
    stop: (): void => { server.stop(true); },
    received: (): string[] => received,
    reset: (): void => { received = []; },
  };
}

const settings: SmtpSettings = {
  host: "127.0.0.1",
  port: 2525,
  username: "terrence",
  password: "hunter2",
  senderEmail: "terrence@example.com",
};

describe("sendEmail", () => {
  let fake: ReturnType<typeof createFakeSmtpServer>;
  let testSettings: SmtpSettings;

  beforeAll(() => {
    fake = createFakeSmtpServer();
    testSettings = { ...settings, port: fake.port };
  });

  afterAll(() => {
    fake.stop();
  });

  test("delivers a message through EHLO/AUTH/DATA with correct headers", async () => {
    fake.reset();
    await sendEmail(testSettings, {
      to: ["one@example.com", "two@example.com"],
      subject: "Drift Detected - prod",
      text: "Workspace: prod\nDetails: https://terraform.example.test/run/1",
    });

    const lines = fake.received();
    expect(lines).toContain("From: terrence@example.com");
    expect(lines).toContain("To: one@example.com, two@example.com");
    expect(lines).toContain("Subject: Drift Detected - prod");
    expect(lines).toContain("Content-Type: text/plain; charset=utf-8");
    expect(lines).toContain("Workspace: prod");
    expect(lines).toContain("Details: https://terraform.example.test/run/1");
  });

  test("dot-stuffs lines that start with a period", async () => {
    fake.reset();
    await sendEmail(testSettings, {
      to: ["one@example.com"],
      subject: "Dot test",
      text: ".hidden-line\nnormal",
    });
    expect(fake.received()).toContain("..hidden-line");
    expect(fake.received()).toContain("normal");
  });

  test("sanitizes CRLF out of the subject", async () => {
    fake.reset();
    await sendEmail(testSettings, {
      to: ["one@example.com"],
      subject: "Injection\r\nBcc: evil@example.com",
      text: "body",
    });
    expect(fake.received()).toContain("Subject: Injection  Bcc: evil@example.com");
  });

  test("fails when a recipient is rejected", async () => {
    const strict = createFakeSmtpServer({ rejectRcpt: "ghost@example.com" });
    try {
      await expect(sendEmail(
        { ...settings, port: strict.port },
        { to: ["ghost@example.com"], subject: "s", text: "b" },
      )).rejects.toThrow(/RCPT TO rejected/);
    } finally {
      strict.stop();
    }
  });
});
