import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

const PROXY_PORT = 18080;
const PING_INTERVAL_MS = 300;
const DUMMY_MSG_COUNT = 5;

async function waitForServer(
  url: string,
  maxAttempts = 30,
  delayMs = 50
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        res.body?.cancel();
        return;
      }
    } catch {
      // Not ready yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

async function collectSSEStream(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks.join("");
}

describe("SSE proxy", () => {
  let dummyServer: ReturnType<typeof Bun.serve>;
  let proxyProc: ReturnType<typeof Bun.spawn>;

  beforeAll(() => {
    const encoder = new TextEncoder();
    dummyServer = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api") {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          new ReadableStream({
            async start(controller) {
              let i = 0;
              const t = setInterval(() => {
                controller.enqueue(
                  encoder.encode(`data: msg ${i++}\n\n`)
                );
                if (i > DUMMY_MSG_COUNT) {
                  clearInterval(t);
                  controller.close();
                }
              }, 80);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      },
    });
  });

  afterAll(() => {
    dummyServer.stop();
    proxyProc?.kill();
  });

  beforeEach(() => {
    proxyProc = Bun.spawn({
      cmd: ["bun", "run", "src/server.ts"],
      cwd: import.meta.dir + "/..",
      env: {
        ...process.env,
        UPSTREAM_URL: `http://localhost:${dummyServer.port}`,
        PORT: String(PROXY_PORT),
        PING_INTERVAL: String(PING_INTERVAL_MS),
      },
      stdout: "inherit",
      stderr: "inherit",
    });
  });

  afterEach(() => {
    proxyProc?.kill();
  });

  it("forwards SSE data and injects keep-alive pings", async () => {
    const proxyUrl = `http://localhost:${PROXY_PORT}/`;
    await waitForServer(proxyUrl);

    const output = await collectSSEStream(proxyUrl);

    // Upstream sends data: msg 0 .. data: msg 5
    for (let i = 0; i <= DUMMY_MSG_COUNT; i++) {
      expect(output).toContain(`data: msg ${i}`);
    }

    // Proxy injects : PING comments
    expect(output).toContain(": PING");
  });

  it("passes through non-SSE responses untouched", async () => {
    const proxyUrl = `http://localhost:${PROXY_PORT}/api`;
    await waitForServer(proxyUrl);

    const res = await fetch(proxyUrl);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body).toBe('{"ok":true}');
    expect(body).not.toContain(": PING");
  });
});
