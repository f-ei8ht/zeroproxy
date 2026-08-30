import { parseArgs } from "node:util";
import { styleText } from "node:util";

const DEFAULT_PORT = 9101;
const DEFAULT_NAME = "A";

export function mockUpstream(name: string, port: number = 0): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        return srv.upgrade(req, { data: {} }) ? undefined : new Response("Bad Request", { status: 400 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") {
        return Response.json({ servedBy: `upstream-${name}`, pid: process.pid, time: new Date().toISOString() });
      }
      const user = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
      if (user) return Response.json({ user: user[1]!, servedBy: `upstream-${name}` });
      // Any other path answers 200 so the proxy's health probes stay green.
      return new Response(`upstream-${name}`, { status: 200 });
    },
    websocket: {
      message(ws, msg) {
        ws.send(`echo from upstream-${name}: ${msg}`);
      },
    },
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string" },
      name: { type: "string" },
    },
  });
  const name = values.name ?? DEFAULT_NAME;
  const server = mockUpstream(name, Number(values.port ?? DEFAULT_PORT));
  console.log(styleText("green", `upstream-${name} listening on localhost:${server.port}`));
}
