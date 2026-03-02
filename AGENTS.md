SSE heartbeat proxy that sits between CDN/client and backend, injecting keep-alive comments into SSE streams to prevent connection timeouts.

## Running

```bash
bun install
UPSTREAM_URL=http://localhost:3000 bun run start
```

## Stack

- Bun runtime
- TypeScript with strict mode enabled

## Configuration

| Variable | Required | Example |
| :--- | :--- | :--- |
| `UPSTREAM_URL` | Yes | `http://localhost:3000` |
| `PORT` | No | `8080` |
| `PING_INTERVAL` | No | `15000` (ms) |
| `PING_PAYLOAD` | No | `: PING\n\n` |
