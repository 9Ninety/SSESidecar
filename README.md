# SSE Sidecar

A lightweight SSE heartbeat proxy designed to sit between your clients and backend. It forwards all traffic as-is, but for SSE streams (`text/event-stream`), it periodically injects keep-alive comments to prevent intermediaries like CDNs, load balancers, and firewalls from dropping idle connections.

```mermaid
graph LR
    A[Client / CDN] -- request --> B[SSE Sidecar]
    B -- request --> C[Backend]
    C -- SSE stream --> B
    B -- SSE stream + pings --> A
```

## How it works

Non-SSE responses pass through as-is. For SSE responses (`text/event-stream`), the proxy periodically injects `: PING` comments into the stream. SSE clients ignore comment lines (those starting with `:`), so your application doesn't need to handle them.

Connections are cleaned up in both directions when either the client disconnects or the backend closes.

## Configuration

| Variable | Description | Default |
| :--- | :--- | :--- |
| `UPSTREAM_URL` | Backend URL, e.g. `http://localhost:3000` | Required |
| `PORT` | Proxy listen port | `8080` |
| `PING_INTERVAL` | Ms between heartbeats | `15000` |
| `PING_PAYLOAD` | Heartbeat content | `: PING\n\n` |

## Usage

### Standalone

```bash
bun install
UPSTREAM_URL=http://localhost:3000 bun run start
```

### Docker

Build with a date-based tag:

```bash
./scripts/build.sh
# custom tag: ./scripts/build.sh 2025010151
```

### Docker Compose

Run it as a sidecar next to your backend:

```yaml
services:
  backend:
    build: .
    ports:
      - "3000:3000"

  sse-proxy:
    image: sse-sidecar:2025010151 # tag from ./scripts/build.sh
    ports:
      - "8080:8080"
    environment:
      UPSTREAM_URL: http://backend:3000
      PORT: 8080
      PING_INTERVAL: 15000
    depends_on:
      - backend
```

Then point your CDN or clients at `sse-proxy:8080` instead of `backend:3000`.

### Behind Nginx

If Nginx is already in front, just point it at the sidecar:

```nginx
location /events {
    proxy_pass http://sse-proxy:8080;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
    proxy_buffering off;
    chunked_transfer_encoding off;
}
```

If you put another proxy in front of the sidecar, make sure that hop uses HTTP/1.1 or newer. Nginx defaults to HTTP/1.0 for upstream proxying, which can make small streamed responses look randomly slow because the response body is no longer framed the way modern clients expect. Setting `proxy_http_version 1.1;` avoids that trap.

### CDN idle timeouts

Most CDNs and load balancers have idle timeouts (CloudFlare: 100s, ALB: 60s). Set `PING_INTERVAL` below whatever your lowest timeout is:

```bash
# AWS ALB has a 60s idle timeout, so 30s is safe
PING_INTERVAL=30000 UPSTREAM_URL=http://backend:3000 bun run src/server.ts
```

## Testing

```bash
bun test
```

Spins up a dummy SSE backend and the proxy, then checks that data gets forwarded and pings are injected.
