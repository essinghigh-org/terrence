import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { fetchResolvedExternalUrlStream, setExternalUrlTransportForTests } from "../../src/lib/url-safety";

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server has no TCP address");
  return address.port;
}

describe("streamed external URL responses", () => {
  let server: Server;
  let receivedUserAgent: string | undefined;

  beforeAll(async () => {
    setExternalUrlTransportForTests(undefined);
    server = createServer((request, response): void => {
      const userAgent = request.headers["user-agent"];
      receivedUserAgent = Array.isArray(userAgent) ? userAgent[0] : userAgent;
      response.writeHead(200, { "content-length": "32" });
      response.write("partial response");
      setTimeout((): void => {
        response.socket?.destroy();
      }, 10);
    });
    await new Promise<void>((resolve, reject): void => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", (): void => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve): void => {
      server.close((): void => {
        resolve();
      });
    });
    setExternalUrlTransportForTests(undefined);
  });

  it("errors a pending reader when the response closes before end", async () => {
    const response = await fetchResolvedExternalUrlStream(
      { address: "127.0.0.1", url: `http://127.0.0.1:${serverPort(server)}/partial` },
      { method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_024 },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a response body reader");

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("partial response");
    expect(receivedUserAgent).toBe("Terrence");
    await expect(reader.read()).rejects.toThrow(/External response closed before completing|aborted/);

    const customResponse = await fetchResolvedExternalUrlStream(
      { address: "127.0.0.1", url: `http://127.0.0.1:${serverPort(server)}/custom` },
      {
        method: "GET",
        headers: { "User-Agent": "CustomAgent/1.0" },
        timeoutMs: 5_000,
        maxResponseBytes: 1_024,
      },
    );
    const customReader = customResponse.body?.getReader();
    if (customReader === undefined) throw new Error("Expected a custom response body reader");

    const customFirst = await customReader.read();
    expect(new TextDecoder().decode(customFirst.value)).toBe("partial response");
    expect(receivedUserAgent).toBe("CustomAgent/1.0");
    await expect(customReader.read()).rejects.toThrow(/External response closed before completing|aborted/);
  });
});
