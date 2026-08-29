import { styleText } from "node:util";
import { watch } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { compileRoutes, matchRoute } from "./router";
import type { CompiledRoute, Match } from "./router";
import { pickEncoding, compressBody, shouldCompress } from "./compress";
import { serveStatic } from "./static";
import { proxyRequest, roundRobin } from "./proxy";
import type { Balancer } from "./proxy";
import { isWebSocketRequest, toSendable, upstreamSocketUrl } from "./ws";
import type { WsClient, WsData } from "./ws";

const SHUTDOWN_TIMEOUT_MS = 10000;

type Runtime = {
  config: Config;
  compiled: CompiledRoute[];
  picks: Map<string, Balancer>;
};

const START = Date.now();
let requests = 0;
let errors = 0;

function log(req: Request, status: number): void {
  const color = status < 400 ? "green" : status < 500 ? "yellow" : "red";
  const time = styleText("gray", new Date().toISOString());
  console.log(`${time} ${req.method} ${new URL(req.url).pathname} ${styleText(color, String(status))}`);
}

function healthz(): Response {
  const uptime = Math.round((Date.now() - START) / 1000);
  return Response.json({ status: "ok", uptime, requests, errors });
}

function applyConfig(runtime: Runtime, config: Config): void {
  runtime.config = config;
  runtime.compiled = compileRoutes(config.routes);
  runtime.picks.clear();
  for (const route of config.routes) {
    if (route.upstream) runtime.picks.set(route.pattern, roundRobin(route.upstream));
  }
}

async function handle(req: Request, runtime: Runtime, match: Match | undefined, url: URL): Promise<Response> {
  let response: Response;
  if (url.pathname === "/healthz") {
    response = healthz();
  } else if (!match) {
    response = new Response("Not Found", { status: 404, statusText: "Not Found" });
  } else if (match.route.upstream) {
    response = await proxyRequest(req, runtime.picks.get(match.route.pattern)!);
  } else if (match.route.static) {
    const subpath = match.params["0"] ?? url.pathname;
    response = serveStatic(req, match.route.static, match.route.index, subpath, match.route.fallback);
  } else {
    response = new Response("Not Found", { status: 404, statusText: "Not Found" });
  }

  if (runtime.config.compression) {
    const encoding = pickEncoding(req.headers.get("accept-encoding"));
    if (shouldCompress(encoding, response)) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-encoding", encoding);
      response = new Response(compressBody(response.body!, encoding), {
        status: response.status,
        headers,
      });
    }
  }
  return response;
}

async function main(): Promise<void> {
  let { config, source } = await loadConfig(process.argv.slice(2));
  const runtime: Runtime = { config, compiled: [], picks: new Map() };
  applyConfig(runtime, config);

  const server: Server<WsData> = Bun.serve({
    port: runtime.config.port,
    hostname: runtime.config.host,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const match = matchRoute(runtime.compiled, req.method, url.pathname);
      if (isWebSocketRequest(req) && match?.route.upstream && match.route.ws) {
        const accepted = srv.upgrade(req, {
          data: { target: upstreamSocketUrl(match.route.upstream[0]!, req), buffer: [] },
        });
        return accepted ? undefined : new Response("Bad Request", { status: 400 });
      }
      try {
        const res = await handle(req, runtime, match, url);
        requests++;
        log(req, res.status);
        return res;
      } catch {
        errors++;
        log(req, 500);
        return new Response("Internal Server Error", { status: 500 });
      }
    },
    websocket: {
      open(ws: WsClient) {
        const upstream = new WebSocket(ws.data.target);
        ws.data.upstream = upstream;
        upstream.onopen = () => {
          for (const msg of ws.data.buffer) upstream.send(msg);
          ws.data.buffer.length = 0;
        };
        upstream.onmessage = (e) => ws.send(e.data);
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
      },
      message(ws: WsClient, msg) {
        const sendable = toSendable(msg);
        const upstream = ws.data.upstream;
        if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(sendable);
        else ws.data.buffer.push(sendable);
      },
      close(ws: WsClient) {
        ws.data.upstream?.close();
      },
    },
  });

  console.log(styleText("green", `zeroproxy listening on http://${runtime.config.host}:${server.port}`));

  if (source) {
    watch(source, async () => {
      try {
        const next = await loadConfig(process.argv.slice(2));
        config = next.config;
        source = next.source;
        applyConfig(runtime, config);
        console.log(styleText("green", "config reloaded"));
      } catch (err) {
        console.error(styleText("red", `reload failed: ${err instanceof Error ? err.message : err}`));
      }
    });
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(styleText("yellow", "shutting down, draining in-flight requests"));
    server.stop();
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(styleText("red", `error: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
