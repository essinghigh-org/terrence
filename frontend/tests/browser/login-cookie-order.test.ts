import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

let clientJavascript = "";

beforeAll(async (): Promise<void> => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/lib/api.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success || build.outputs[0] === undefined) throw new Error("Could not build authentication client");
  clientJavascript = await build.outputs[0].text();
});

test.each(["/users/login", "/users/login/mfa", "/users/login?returnTo=%2Fapp"])(
  "a delayed %s response cannot replace the browser refresh cookie",
  async (endpoint) => {
    let releaseOld: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve): void => {
      markStarted = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/client.js")
          return new Response(clientJavascript, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/")
          return new Response("<!doctype html><title>Session ordering fixture</title>", {
            headers: { "Content-Type": "text/html" },
          });
        if (request.method === "GET") return new Response(null, { status: 204 });
        if (path.endsWith("/users/refresh")) {
          const current = request.headers.get("Cookie")?.includes("terrence_refresh=new-cookie") ? "new" : "old";
          return Response.json({ data: { attributes: { token: `${current}-refreshed` } } });
        }
        const body = (await request.json()) as { data: { attributes: Record<string, unknown> } };
        const attrs = body.data.attributes;
        if (path.endsWith("/users/login/complete")) {
          return Response.json(
            { data: { attributes: { token: `${attrs["session-commit-token"]}-access` } } },
            {
              headers: {
                "Set-Cookie": `terrence_refresh=${attrs["session-commit-token"]}-cookie; HttpOnly; Path=/; SameSite=Lax`,
              },
            },
          );
        }
        const subject = attrs["username"] === "old" ? "old" : "new";
        const response = (): Response =>
          Response.json(
            {
              data: {
                attributes:
                  request.headers.get("X-Terrence-Session-Mode") === "staged"
                    ? { "session-commit-token": subject }
                    : { token: `${subject}-access` },
              },
            },
            {
              // A delayed legacy/misbehaving server must not alter the cookie jar
              // even before JS receives the response and checks its generation.
              headers: { "Set-Cookie": `terrence_refresh=${subject}-cookie; HttpOnly; Path=/; SameSite=Lax` },
            },
          );
        if (subject === "old") {
          markStarted?.();
          return new Promise<Response>((resolve): void => {
            releaseOld = (): void => {
              resolve(response());
            };
          });
        }
        return response();
      },
    });
    const page = new Bun.WebView({
      backend: { type: "chrome", url: false, argv: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"] },
    });
    const evaluate = async (script: string): Promise<unknown> => page.evaluate(script);
    try {
      await page.navigate(server.url.toString());
      await evaluate(`(async () => {
      window.client = await import('/client.js');
      window.stale = window.client.fetchApi(${JSON.stringify(endpoint)}, {
        method: 'POST', body: JSON.stringify({data:{attributes:{username:'old', password:'test', code:'123456', 'challenge-token':'old', 'browser-session':true}}})
      }).catch(error => error.name);
    })()`);
      await started;
      expect(
        await evaluate(`(async () => {
      const result = await window.client.fetchApi('/users/login', {
        method: 'POST', body: JSON.stringify({data:{attributes:{username:'new',password:'test','browser-session':true}}})
      });
      window.client.setAuthToken(result.data.attributes.token, null, true);
      return window.client.getAuthToken();
    })()`),
      ).toBe("new-access");
      releaseOld?.();
      expect(await evaluate("window.stale")).toBe("AbortError");
      expect(await evaluate("window.client.getAuthToken()")).toBe("new-access");
      expect(
        await evaluate(`(async () => {
      window.client.expireAuthSession();
      return window.client.bootstrapAuth();
    })()`),
      ).toBe("new-refreshed");
      expect(await evaluate("document.cookie")).not.toContain("terrence_refresh");
    } finally {
      releaseOld?.();
      page.close();
      await server.stop(true);
    }
  },
  30_000,
);
