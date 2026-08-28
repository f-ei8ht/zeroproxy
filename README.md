# zeroproxy

A zero-dependency **reverse proxy, HTTP router, and static file server** built on Bun's
runtime built-ins — `"dependencies": {}`. No npm installs, no packages, nothing to audit.

**Track:** C — Web & Network
**Runtime:** Bun 1.4+
**Dependencies:** zero

---

## What it does

One Bun-native binary that does three things a real backend needs, none of which reach
for a package:

1. **Reverse proxy** — forwards requests to one or more upstream targets, streaming bodies
   without buffering, with round-robin load balancing across multiple upstreams.
2. **Static file server** — serves a directory with correct MIME types, `Range` requests
   for partial content, and conditional caching (`ETag`/`If-None-Match`).
3. **HTTP router** — matches incoming requests to handlers using native `URLPattern`, with
   method, wildcard, and named-parameter support.

It is the kind of tool most people build with `express` + `http-proxy-middleware` +
`serve-static`. This one imports none of them.

## Quick start

```bash
# Build
bun build ./src/index.ts --compile --outfile zeroproxy

# Run with a config file
./zeroproxy --config zeroproxy.config.json

# Or run directly without compiling
bun run src/index.ts --port 8080 --upstream http://localhost:3000
```

One command, one runnable artifact — no install step.

## Configuration

```json
{
  "port": 8080,
  "routes": [
    { "pattern": "/api/*", "upstream": "http://localhost:3000" },
    { "pattern": "/users/:id", "upstream": ["http://10.0.0.1:3000", "http://10.0.0.2:3000"] },
    { "pattern": "/static/*", "static": "./public" },
    { "pattern": "/", "static": "./public/index.html" }
  ],
  "compression": true
}
```

CLI flags (`--port`, `--upstream`, `--config`, `--root`) override or extend the file.

## Features

- **Routing** — `URLPattern`-based matching: wildcards (`/api/*`) and named params (`/users/:id`).
- **Reverse proxying** — streams request/response bodies via `fetch()` without buffering the
  whole payload in memory; round-robin across multiple upstreams.
- **Static serving** — correct `Content-Type` by extension, `ETag` generation,
  `Range`-header partial content (206), and directory index fallback.
- **Compression** — negotiates `Accept-Encoding` and transparently gzip/brotli-compresses
  proxied and static responses using native `CompressionStream`.
- **Concurrency** — Bun's event loop handles concurrent connections natively; no thread pool
  or worker-management code is written by this project.
- **Graceful shutdown** — drains in-flight requests on `SIGINT`/`SIGTERM` before exiting.

## Concurrency model (honest disclosure)

`zeroproxy` relies entirely on Bun's single-threaded, non-blocking event loop — the same
model Node/Bun use for every I/O operation. There is no manual thread pool, no
`worker_threads`, no custom scheduler written here. The "concurrency" is the runtime doing
what it always does. Under sustained load with slow upstreams a single process is bound by
that one event loop; horizontal scaling (multiple processes behind an OS-level load
balancer) is the intended path beyond that and is out of scope for this submission.

## Limits (honest gaps)

- No HTTP/2 or HTTP/3 — Bun's built-in server is HTTP/1.1.
- No TLS termination built in; run behind a TLS-terminating layer (or use Bun's native TLS
  options) for production HTTPS.
- Load balancing is round-robin only — no health checks or weighted routing.
- Not benchmarked against nginx/Caddy for raw throughput; correctness and stdlib-craft are
  the priority here, stated plainly rather than hidden.

## Zero-dependency compliance

- `package.json` → `"dependencies": {}` (dev-only tooling in `devDependencies` never ships
  in the compiled artifact).
- `bun pm ls` output in `deps-proof.txt` shows zero third-party runtime dependencies.
- Every "I'd normally import X" decision is documented in [`STDLIB.md`](./STDLIB.md).

### Key substitutions (full list in STDLIB.md)

| Would normally install | Used instead |
|---|---|
| `path-to-regexp` | `URLPattern` |
| `http-proxy-middleware` | `fetch()` + `Bun.serve()` streaming |
| `serve-static` / `send` | `Bun.file()` + manual `Range`/`ETag` handling |
| `compression` (gzip middleware) | native `CompressionStream` |
| `mime-types` | a small hand-written extension → MIME table |
| `chalk` (CLI log output) | `util.styleText()` |
| `minimist` (arg parsing) | `util.parseArgs()` |

## Testing

```bash
bun test
```

Covers route matching (wildcard and param edge cases), proxy streaming, static file MIME /
`Range` / `ETag` behavior, and compression negotiation. Tests use `bun:test`, a built-in —
no test framework dependency.

## License

MIT
