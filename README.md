# zeroproxy

A zero-dependency **reverse proxy, HTTP router, and static file server** built on Bun's
runtime built-ins - `"dependencies": {}`. No npm installs, no packages, nothing to audit.

**Track:** C - Web & Network
**Runtime:** Bun 1.4+
**Dependencies:** zero

---

## What it does

One Bun-native binary that does the four things a real backend needs, none of which reach
for a package:

1. **Reverse proxy** - forwards requests to one or more upstream targets, streaming bodies
   without buffering, with round-robin load balancing and automatic failover across
   multiple upstreams.
2. **WebSocket proxy** - tunnels WebSocket connections to an upstream using the global
   `WebSocket` client and `Bun.serve`'s native upgrade, with no `ws` package.
3. **Static file server** - serves a directory with correct MIME types, `Range` requests
   for partial content, `ETag`/`If-None-Match` caching, directory listings, and SPA
   fallback.
4. **HTTP router** - matches incoming requests to handlers using native `URLPattern`, with
   method, wildcard, and named-parameter support.

It is the kind of tool most people build with `express` + `http-proxy-middleware` +
`serve-static`. This one imports none of them.

## Quick start

One command builds (choose either):

```bash
make build                 # needs make
bun run build              # needs only Bun
```

Then run with a config file, or directly without compiling:

```bash
./zeroproxy --config zeroproxy.config.json
bun run src/index.ts --port 8080 --upstream http://localhost:3000
```

Every task is available through both `make <task>` and `bun run <task>` (the `Makefile`
wraps the same `package.json` scripts - either one is a single command):

| Task | Effect |
|---|---|
| `build` | Compile `src/` into the `zeroproxy` binary |
| `test` | Run the test suite (`bun test`) |
| `typecheck` | Type-check with `tsc --noEmit` |
| `proof` | Write `deps-proof.txt` (`bun pm ls` output) |
| `reproduce` | Build twice and write `BUILD_HASHES.txt` (byte-identical check) |
| `clean` | Remove binaries and generated proof/hash files |

Note on `reproduce`: Bun embeds the output filename into the compiled binary, so
byte-identical builds require a constant `--outfile` name. The target builds twice to one
name and copies the results apart. Reproducibility holds on the same machine and toolchain,
as the bonus requires; two builds on different environments may differ.

One command, one runnable artifact - no install step.

## Configuration

```json
{
  "port": 8080,
  "routes": [
    { "pattern": "/api/*", "upstream": "http://localhost:3000" },
    {
      "pattern": "/ws/*",
      "upstream": ["http://10.0.0.1:3000", "http://10.0.0.2:3000"],
      "ws": true
    },
    { "pattern": "/users/:id", "upstream": "http://localhost:3000" },
    { "pattern": "/static/*", "static": "./public", "fallback": "./public/index.html" }
  ],
  "compression": true
}
```

Route keys:

- `pattern` - `URLPattern` route string (wildcards `/*`, named params `/:id`).
- `upstream` - one URL or an array of URLs; requests are round-robined across them and
  fail over to the next on connection error or timeout.
- `static` - a directory (or single file) to serve.
- `index` - the directory index file name (default `index.html`).
- `fallback` - a file served for unmatched paths inside a `static` route (SPA mode).
- `ws` - set `true` on an `upstream` route to proxy WebSocket connections.
- `method` - restrict the route to one HTTP method.

CLI flags (`--port`, `--host`, `--upstream`, `--config`, `--root`) override or extend the
file. `--upstream` adds a catch-all proxy route on top of any file routes.

A `GET /healthz` endpoint is served on every run, reporting `status`, `uptime`, and
in-flight `requests`/`errors` counters. When a config file is used, it is watched and
routes reload live on change (port and host are fixed for the process lifetime).

## Features

- **Routing** - `URLPattern`-based matching: wildcards (`/api/*`) and named params (`/users/:id`).
- **Reverse proxying** - streams request/response bodies via `fetch()` without buffering the
  whole payload in memory; round-robin across multiple upstreams with failover.
- **WebSocket proxying** - native `Bun.serve` upgrade tunnels to the upstream via the global
  `WebSocket` client; client and upstream frames are piped both ways with no `ws` package.
- **Static serving** - correct `Content-Type` by extension, `ETag` generation,
  `Range`-header partial content (206), directory index, auto-generated directory listings,
  and SPA `fallback`.
- **Compression** - negotiates `Accept-Encoding` and transparently gzip/deflate/brotli/zstd-compresses
  proxied and static responses using native `CompressionStream`.
- **Health + metrics** - a `GET /healthz` endpoint reports uptime and request/error counts.
- **Live config reload** - watches the config file and swaps routes in place without
  dropping connections.
- **Concurrency** - Bun's event loop handles concurrent connections natively; no thread pool
  or worker-management code is written by this project.
- **Graceful shutdown** - drains in-flight requests on `SIGINT`/`SIGTERM` before exiting.

## Concurrency model (honest disclosure)

`zeroproxy` relies entirely on Bun's single-threaded, non-blocking event loop - the same
model Node/Bun use for every I/O operation. There is no manual thread pool, no
`worker_threads`, no custom scheduler written here. The "concurrency" is the runtime doing
what it always does. Under sustained load with slow upstreams a single process is bound by
that one event loop; horizontal scaling (multiple processes behind an OS-level load
balancer) is the intended path beyond that and is out of scope for this submission.

## Limits (honest gaps)

- No HTTP/2 or HTTP/3 - Bun's built-in server is HTTP/1.1.
- No TLS termination built in; run behind a TLS-terminating layer (or use Bun's native TLS
  options) for production HTTPS.
- Load balancing is round-robin only - no health checks or weighted routing.
- Failover only retries requests that are safe to replay (no body, or an idempotent method
  like `GET`/`HEAD`). A request with a body that fails mid-flight is not replayed, because
  a consumed stream cannot be sent twice - same trade-off real proxies make.
- WebSocket connections always target the first upstream; round-robin and failover do not
  apply to live sockets.
- Not benchmarked against nginx/Caddy for raw throughput; correctness and stdlib-craft are
  the priority here, stated plainly rather than hidden.

## Zero-dependency compliance

- `package.json` has empty `"dependencies": {}` (dev-only tooling in `devDependencies` never ships
  in the compiled artifact).
- `bun pm ls` output in `deps-proof.txt` shows zero third-party runtime dependencies.
- Every "I'd normally import X" decision is documented in [`STDLIB.md`](./STDLIB.md).

### Key substitutions (full list in STDLIB.md)

| Would normally install | Used instead |
|---|---|
| `path-to-regexp` | `URLPattern` |
| `http-proxy-middleware` | `fetch()` + `Bun.serve()` streaming |
| `http-proxy` WebSocket support / `ws` | `Bun.serve()` upgrade + global `WebSocket` |
| `serve-static` / `send` | `Bun.file()` + manual `Range`/`ETag` handling |
| `compression` (gzip middleware) | native `CompressionStream` |
| `mime-types` | a small hand-written extension-to-MIME table |
| `chalk` (CLI log output) | `util.styleText()` |
| `minimist` (arg parsing) | `util.parseArgs()` |

## Testing

```bash
bun test
```

Covers route matching (wildcard and param edge cases), proxy streaming and upstream
failover, WebSocket request detection and URL mapping, static file MIME / `Range` / `ETag`
behavior, directory listings and SPA fallback, config validation, and compression
negotiation. Tests use `bun:test`, a built-in - no test framework dependency.

## License

MIT
