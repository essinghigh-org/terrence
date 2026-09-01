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

  beforeAll(async () => {
    setExternalUrlTransportForTests(undefined);
    server = createServer((_request, response): void => {
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
    await expect(reader.read()).rejects.toThrow(/External response closed before completing|aborted/);
  });
});
