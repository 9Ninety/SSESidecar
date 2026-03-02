const UPSTREAM_URL = process.env.UPSTREAM_URL;
if (!UPSTREAM_URL) {
  console.error("UPSTREAM_URL environment variable is required");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8080);
const PING_INTERVAL = Number(process.env.PING_INTERVAL ?? 15000);
const PING_PAYLOAD = process.env.PING_PAYLOAD ?? ": PING\n\n";
const UPSTREAM_WS = UPSTREAM_URL.replace(/^http/, "ws");

const PING_BYTES = new TextEncoder().encode(PING_PAYLOAD);

interface WsData {
  path: string;
  upstream: WebSocket | null;
}

const server = Bun.serve<WsData>({
  port: PORT,

  async fetch(req, server) {
    const start = Date.now();
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const ok = server.upgrade(req, { data: { path, upstream: null } });
      console.log(`WS  ${path} ${ok ? "upgraded" : "failed"}`);
      if (!ok) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    const upstreamUrl = `${UPSTREAM_URL}${path}`;
    const headers = new Headers(req.headers);

    // Bun auto-decompresses but preserves the content-encoding header, which
    // causes mismatches when nginx/CDN sits in front.
    headers.set("accept-encoding", "identity");

    // Buffer the body so it goes out with Content-Length instead of chunked.
    // Some backends forward request headers verbatim and transfer-encoding in
    // a forwarded request causes undici to reject it.
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody ? await req.arrayBuffer() : undefined;
    if (body) {
      headers.delete("transfer-encoding");
      headers.set("content-length", String(body.byteLength));
    }

    let response: Response;
    try {
      response = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
      });
    } catch (error) {
      console.error(`ERR ${req.method} ${path} upstream unreachable:`, error);
      return new Response("Bad Gateway", { status: 502 });
    }

    const elapsed = Date.now() - start;
    const contentType = response.headers.get("content-type") ?? "";
    const isSSE = contentType.includes("text/event-stream");

    console.log(
      `${isSSE ? "SSE" : "   "} ${req.method} ${path} ${response.status} (${elapsed}ms)`,
    );

    if (!isSSE) {
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }

    const sseHeaders = new Headers(response.headers);

    const upstreamBody = response.body;
    if (!upstreamBody) {
      return new Response(null, {
        status: response.status,
        headers: sseHeaders,
      });
    }

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const stream = new ReadableStream({
      async start(controller) {
        heartbeat = setInterval(() => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(PING_BYTES);
          } catch {
            cleanup();
          }
        }, PING_INTERVAL);

        const reader = upstreamBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || closed) {
              break;
            }
            controller.enqueue(value);
          }
        } catch (error) {
          if (!closed) {
            console.error(`SSE ${path} read error:`, error);
          }
        } finally {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: response.status,
      headers: sseHeaders,
    });
  },

  websocket: {
    open(ws) {
      const upstream = new WebSocket(`${UPSTREAM_WS}${ws.data.path}`);
      upstream.onmessage = (event) => ws.send(event.data);
      upstream.onclose = (event) => ws.close(event.code, event.reason);
      upstream.onerror = () => ws.close(1011, "Upstream WebSocket error");
      ws.data.upstream = upstream;
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      }
    },
    close(ws, code, reason) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.close(code, reason);
      }
      ws.data.upstream = null;
    },
  },

  error(error) {
    console.error("Unhandled error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(
  `SSE heartbeat proxy listening on :${server.port}, upstream ${UPSTREAM_URL}`,
);
