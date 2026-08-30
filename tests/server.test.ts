// Integration coverage for the wiring in src/index.ts: spawns the real
// server as a subprocess and exercises healthz, proxying, 405, static
// serving, the WebSocket tunnel, live config reload, and SIGTERM shutdown.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

let httpUpstream: ReturnType<typeof Bun.serve>;
let wsUpstream: ReturnType<typeof Bun.serve>;
let child: ChildProcess;
let cfgDir: string;
let cfgPath: string;
let base: string;

function writeConfig(routes: unknown[]): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  writeFileSync(cfgPath, JSON.stringify({ port, host: "127.0.0.1", shutdownTimeoutMs: 500, routes }, null, 2));
  return port;
}

async function pollUntil(url: string, check: (res: Response) => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok && (await check(res))) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition never met at ${url}`);
}

beforeAll(async () => {
  httpUpstream = Bun.serve({ port: 0, fetch: () => new Response("upstream-ok") });
  wsUpstream = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        return srv.upgrade(req, { data: {} }) ? undefined : new Response("Bad Request", { status: 400 });
      }
      return new Response("ok");
    },
    websocket: {
      message(ws, msg) {
        ws.send(msg);
      },
    },
  });

  cfgDir = mkdtempSync(join(tmpdir(), "zp-server-"));
  cfgPath = join(cfgDir, "config.json");
  const port = writeConfig([
    { pattern: "/api/*", upstream: `http://localhost:${httpUpstream.port}` },
    { pattern: "/ws/*", upstream: `http://localhost:${wsUpstream.port}`, ws: true },
    { pattern: "/fixed/post", method: "POST", upstream: `http://localhost:${httpUpstream.port}` },
    { pattern: "/static/*", static: cfgDir },
  ]);

  child = spawn("bun", ["run", "src/index.ts", "--config", cfgPath], {
    cwd: ROOT,
    stdio: "ignore",
  });
  base = `http://127.0.0.1:${port}`;
  await pollUntil(`${base}/healthz`, async () => true, 4000);
});

afterAll(() => {
  if (child.exitCode === null) child.kill("SIGTERM");
  httpUpstream.stop(true);
  wsUpstream.stop(true);
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("server", () => {
  test("/healthz reports status and counters", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.requests).toBe("number");
    expect(typeof body.errors).toBe("number");
  });

  test("proxies a request through to the upstream", async () => {
    const res = await fetch(`${base}/api/anything`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
    expect(res.headers.get("via")).toBe("1.1 zeroproxy");
  });

  test("answers a method mismatch with 405 and Allow through the server", async () => {
    const res = await fetch(`${base}/fixed/post`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("serves static files through the server", async () => {
    const res = await fetch(`${base}/static/config.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("tunnels a websocket through to the upstream", async () => {
    const wsUrl = base.replace("http", "ws");
    const ws = new WebSocket(`${wsUrl}/ws/echo`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket open timeout")), 4000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket error"));
      };
    });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket reply timeout")), 4000);
      ws.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data);
      };
      ws.send("ping");
    });
    expect(reply).toBe("ping");
    ws.close();
  });

  test("reloads routes when the config file changes", async () => {
    writeConfig([
      { pattern: "/api/*", upstream: `http://localhost:${httpUpstream.port}` },
      { pattern: "/added/*", static: cfgDir },
    ]);
    await pollUntil(`${base}/added/config.json`, async () => true, 4000);
  });

  test("exits cleanly on SIGTERM", async () => {
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("exit timeout")), 4000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);
  });
});
