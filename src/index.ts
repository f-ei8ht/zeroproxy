import { styleText } from "node:util";
import type { Server } from "bun";
import { loadConfig } from "./config";
import { compileRoutes, matchRoute } from "./router";
import { pickEncoding, compressBody, shouldCompress } from "./compress";
import { serveStatic } from "./static";
import { proxyRequest, roundRobin } from "./proxy";

function log(req: Request, status: number): void {
  const color = status < 400 ? "green" : status < 500 ? "yellow" : "red";
  const time = styleText("gray", new Date().toISOString());
  console.log(`${time} ${req.method} ${new URL(req.url).pathname} ${styleText(color, String(status))}`);
}

async function main(): Promise<void> {
  const config = await loadConfig(process.argv.slice(2));
  const compiled = compileRoutes(config.routes);
  const picks = new Map<string, () => string>();
  for (const route of config.routes) {
    if (route.upstream) picks.set(route.pattern, roundRobin(route.upstream));
  }

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req) {
      const url = new URL(req.url);
      const match = matchRoute(compiled, req.method, url.pathname);

      let response: Response;
      if (!match) {
        response = new Response("Not Found", { status: 404, statusText: "Not Found" });
      } else if (match.route.upstream) {
        response = await proxyRequest(req, match.route, picks.get(match.route.pattern)!);
      } else if (match.route.static) {
        const subpath = match.params["0"] ?? url.pathname;
        response = serveStatic(req, match.route.static, match.route.index, subpath);
      } else {
        response = new Response("Not Found", { status: 404, statusText: "Not Found" });
      }

      if (config.compression) {
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

      log(req, response.status);
      return response;
    },
  });

  console.log(styleText("green", `zeroproxy listening on http://${config.host}:${server.port}`));

  const shutdown = (): void => {
    server.stop(true);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
