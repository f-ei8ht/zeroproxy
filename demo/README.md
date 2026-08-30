# Live demo package

This directory is the click-and-play demo: a real zeroproxy in front of two
mock upstreams, serving a dashboard page that exercises every feature from a
browser. Nothing here is fake scaffolding - it is the same binary, config
format, and code paths as any production deployment.

## Run it locally

```bash
make demo        # or: bun run demo, or bun demo/run.ts
```

That starts upstream A on :9101, upstream B on :9102, and zeroproxy on :8080,
waits until the proxy answers, prints the URL, and stays in the foreground.
Open http://localhost:8080. Ctrl-C stops all three.

Manual equivalent:

```bash
bun demo/upstream.ts --port 9101 --name A &
bun demo/upstream.ts --port 9102 --name B &
bun run src/index.ts --config demo/demo.config.json --root demo
```

## What the dashboard shows

- **Live status** - polls the built-in `GET /healthz` every two seconds
  (status, uptime, requests, errors).
- **Reverse proxy + round-robin** - each click fetches `/api/whoami` through
  the `/api/*` route; the JSON names the upstream that answered, so the
  alternation between A and B is visible.
- **Static + Range** - fetches the first 100 bytes of `range-demo.txt` with a
  `Range` header; the static server answers `206` with `Content-Range`.
- **WebSocket tunnel** - opens a socket to `/ws/echo`; zeroproxy upgrades it
  natively and the upstream echoes every frame back through the tunnel.

The page itself is plain HTML, CSS, and JavaScript with no framework and no
build step, served by zeroproxy's own static file server. The demo config is
fixed: routes point only at the two local mock upstreams and the demo files,
so the running proxy is never an open relay.
