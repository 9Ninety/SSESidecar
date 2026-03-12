import { Logger } from "./logger";

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

const logger = new Logger();
const generateRequestId = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");

interface WsData {
  id: string;
  path: string;
  upstream: WebSocket | null;
}

const server = Bun.serve<WsData>({
  port: PORT,

  async fetch(req, server) {
    const id = generateRequestId();
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      logger.info(`[${id}] [WS] → ${path}`);
      const ok = server.upgrade(req, { data: { id, path, upstream: null } });

      if (!ok) {
        logger.error(`[${id}] [WS] upgrade failed`, undefined);
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      logger.info(`[${id}] [101] ← ${path}`);
      return undefined;
    }

    logger.info(`[${id}] [${req.method}] → ${path}`);
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
      logger.error(`[${id}] upstream unreachable`, error);
      return new Response("Bad Gateway", { status: 502 });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isSSE = contentType.includes("text/event-stream");

    logger.info(`[${id}] [${response.status}] ← ${path}`);

    if (!isSSE) {
      return response;
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
          } catch (err) {
            logger.error(`[${id}] [SSE] Failed to send heartbeat`, err);
            cleanup();
          }
        }, PING_INTERVAL);

        logger.info(`[${id}] [SSE] + ${path} Starting heartbeat injection`);

        const reader = upstreamBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              logger.info(`[${id}] [SSE] X ${path} Connection finished`);
              break;
            }

            if (closed) {
              break;
            }

            controller.enqueue(value);
          }
        } catch (error) {
          logger.error(
            `[${id}] [SSE] Upstream connection terminated unexpectedly`,
            error,
          );
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
        logger.info(`[${id}] [SSE] X ${path} Client connection closed`);
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
      const { id, path } = ws.data;
      const upstream = new WebSocket(`${UPSTREAM_WS}${path}`);

      upstream.onopen = () => {
        logger.info(`[${id}] [WS] + ${path} Connected to upstream`);
      };
      upstream.onmessage = (event) => ws.send(event.data);
      upstream.onclose = (event) => {
        logger.info(
          `[${id}] [WS] X ${path} Upstream closed with code ${event.code}`,
        );
        ws.close(event.code, event.reason);
      };
      upstream.onerror = (err) => {
        logger.error(`[${id}] [WS] upstream error`, err);
        ws.close(1011, "Upstream WebSocket error");
      };

      ws.data.upstream = upstream;
    },
    message(ws, message) {
      const upstream = ws.data.upstream;

      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      }
    },
    close(ws, code, reason) {
      const { id, path } = ws.data;
      logger.info(`[${id}] [WS] X ${path} Client closed with code ${code}`);
      const upstream = ws.data.upstream;

      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.close(code, reason);
      }
      ws.data.upstream = null;
    },
  },

  error(err) {
    logger.error("Unhandled error", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

logger.info(
  `SSE heartbeat proxy listening on :${server.port}, upstream ${UPSTREAM_URL}`,
);
