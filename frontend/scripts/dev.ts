import html from "../index.html";

const port = Number(process.env.PORT ?? 5173);
const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";

async function proxyToBackend(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, backendUrl);

  const headers = new Headers(req.headers);
  headers.set("host", target.host);

  const isGetOrHead = req.method === "GET" || req.method === "HEAD";
  const body = isGetOrHead ? undefined : req.body;

  try {
    const res = await fetch(target.toString(), {
      method: req.method,
      headers,
      body,
      // @ts-expect-error Bun / Node fetch duplex
      duplex: "half",
    });

    const responseHeaders = new Headers(res.headers);
    // Keep hop-by-hop and payload length headers clean
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error(`[proxy error] failed to proxy ${req.method} ${url.pathname} to ${target.toString()}:`, err);
    return new Response(JSON.stringify({ error: "Backend proxy error" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

const server = Bun.serve({
  port,
  development: true,
  routes: {
    "/api": proxyToBackend,
    "/api/*": proxyToBackend,
    "/*": html,
  },
});

console.log(`Terrence frontend dev server running at http://localhost:${String(server.port)} (proxying /api -> ${backendUrl})`);
