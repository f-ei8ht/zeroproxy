import { randomUUID } from "node:crypto";
import { styleText } from "node:util";
import { watch } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { allowedMethods, compileRoutes, matchRoute } from "./router";
import type { CompiledRoute, Match } from "./router";
import { pickEncoding, compressBody, shouldCompress } from "./compress";
import { serveStatic } from "./static";
import { proxyRequest } from "./proxy";
import { roundRobin } from "./proxy/balancer";
import type { Balancer } from "./proxy/balancer";
import { healthChecker } from "./proxy/health";
import type { HealthChecker } from "./proxy/health";
import { isWebSocketRequest, toSendable, upstreamSocketUrl } from "./ws";
import type { WsClient, WsData } from "./ws";

const SHUTDOWN_TIMEOUT_MS = 10000;

type Runtime = {
  config: Config;
  compiled: CompiledRoute[];
  picks: Map<string, Balancer>;
  health?: HealthChecker;
};

const START = Date.now();
let requests = 0;
let errors = 0;

function log(req: Request, status: number, started: number): void {
  const color = status < 400 ? "green" : status < 500 ? "yellow" : "red";
  const time = styleText("gray", new Date().toISOString());
  const ms = styleText("gray", `${Date.now() - started}ms`);
  console.log(`${time} ${req.method} ${new URL(req.url).pathname} ${styleText(color, String(status))} ${ms}`);
}

function healthz(): Response {
  const uptime = Math.round((Date.now() - START) / 1000);
  return Response.json({ status: "ok", uptime, requests, errors });
}

function applyConfig(runtime: Runtime, config: Config): void {
  runtime.health?.stop();
  runtime.config = config;
  runtime.compiled = compileRoutes(config.routes);
  runtime.picks.clear();
  const balancers: Balancer[] = [];
  for (const route of config.routes) {
    if (route.upstream) {
      const balancer = roundRobin(route.upstream);
      runtime.picks.set(route.pattern, balancer);
      balancers.push(balancer);
    }
  }
  runtime.health = healthChecker(balancers, config.healthCheck);
  runtime.health.start();
}

async function handle(req: Request, runtime: Runtime, match: Match | undefined, url: URL): Promise<Response> {
  let response: Response;
  if (url.pathname === "/healthz") {
    response = healthz();
  } else if (!match) {
    const allowed = allowedMethods(runtime.compiled, url.pathname);
    if (allowed.length > 0) {
      response = new Response("Method Not Allowed", {
        status: 405,
        statusText: "Method Not Allowed",
        headers: { allow: allowed.join(", ") },
      });
    } else {
      response = new Response("Not Found", { status: 404, statusText: "Not Found" });
    }
  } else if (match.route.upstream) {
    response = await proxyRequest(req, runtime.picks.get(match.route.pattern)!, runtime.config.retryBodyLimitBytes);
  } else if (match.route.static) {
    const subpath = match.params["0"] ?? url.pathname;
    response = serveStatic(
      req,
      match.route.static,
      match.route.index,
      subpath,
      match.route.fallback,
      match.route.cacheControl,
    );
  } else {
    response = new Response("Not Found", { status: 404, statusText: "Not Found" });
  }

  if (runtime.config.compression) {
    const encoding = pickEncoding(req.headers.get("accept-encoding"));
    const headers = new Headers(response.headers);
    headers.append("vary", "accept-encoding");
    if (shouldCompress(encoding, response)) {
      headers.delete("content-length");
      headers.set("content-encoding", encoding);
      response = new Response(compressBody(response.body!, encoding), {
        status: response.status,
        headers,
      });
    } else {
      response = new Response(response.body, { status: response.status, headers });
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
    tls: runtime.config.tls
      ? {
          certFile: runtime.config.tls.cert,
          keyFile: runtime.config.tls.key,
        }
      : undefined,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const match = matchRoute(runtime.compiled, req.method, url.pathname);
      if (isWebSocketRequest(req) && match?.route.upstream && match.route.ws) {
        const balancer = runtime.picks.get(match.route.pattern)!;
        const target = balancer.pick();
        const accepted = srv.upgrade(req, {
          data: { target: upstreamSocketUrl(target, req), buffer: [] },
        });
        return accepted ? undefined : new Response("Bad Request", { status: 400 });
      }
      const started = Date.now();
      try {
        const res = await handle(req, runtime, match, url);
        requests++;
        log(req, res.status, started);
        return res;
      } catch {
        errors++;
        log(req, 500, started);
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

  const scheme = runtime.config.tls ? "https" : "http";
  console.log(styleText("green", `zeroproxy listening on ${scheme}://${runtime.config.host}:${server.port}`));

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
    runtime.health?.stop();
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
