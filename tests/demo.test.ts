// End-to-end coverage for the demo package: the shipped demo config validates,
// the dashboard is served at /, Range works on the demo file, proxy requests
// alternate between the two mock upstreams, and the WebSocket tunnel echoes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateConfig } from "../src/config";
import { mockUpstream } from "../demo/upstream";

const ROOT = resolve(import.meta.dir, "..");

let upstreamA: ReturnType<typeof mockUpstream>;
let upstreamB: ReturnType<typeof mockUpstream>;
let child: ChildProcess;
let cfgDir: string;
let base: string;

async function waitUntil(url: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never came up at ${url}`);
}

beforeAll(async () => {
  upstreamA = mockUpstream("A");
  upstreamB = mockUpstream("B");

  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  cfgDir = mkdtempSync(join(tmpdir(), "zp-demo-"));
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        shutdownTimeoutMs: 500,
        routes: [
          { pattern: "/api/*", upstream: [`http://localhost:${upstreamA.port}`, `http://localhost:${upstreamB.port}`] },
          { pattern: "/ws/*", upstream: `http://localhost:${upstreamA.port}`, ws: true },
          { pattern: "/*", static: resolve(ROOT, "demo/site") },
        ],
      },
      null,
      2,
    ),
  );

  child = spawn("bun", ["run", "src/index.ts", "--config", cfgPath], {
    cwd: ROOT,
    stdio: "ignore",
  });
  base = `http://127.0.0.1:${port}`;
  await waitUntil(`${base}/healthz`);
});

afterAll(() => {
  if (child.exitCode === null) child.kill("SIGTERM");
  upstreamA.stop(true);
  upstreamB.stop(true);
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("demo package", () => {
  test("the shipped demo config validates", async () => {
    const raw = JSON.parse(await Bun.file(resolve(ROOT, "demo/demo.config.json")).text());
    const config = validateConfig(raw);
    expect(config.routes).toHaveLength(3);
    expect(config.routes[0]!.upstream).toHaveLength(2);
    expect(config.routes[2]!.static).toBeDefined();
  });

  test("serves the dashboard at the root", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("zeroproxy");
    expect(body).toContain("healthz");
  });

  test("a range request on the demo file returns 206 partial content", async () => {
    const res = await fetch(`${base}/range-demo.txt`, { headers: { range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await res.text()).length).toBe(100);
  });

  test("proxy requests alternate between the mock upstreams", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/api/whoami`);
      expect(res.status).toBe(200);
      seen.add(((await res.json()) as { servedBy: string }).servedBy);
    }
    expect(seen).toEqual(new Set(["upstream-A", "upstream-B"]));
  });

  test("named params pass through the proxy to the upstream", async () => {
    const res = await fetch(`${base}/api/users/42`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string; servedBy: string };
    expect(body.user).toBe("42");
    expect(body.servedBy).toMatch(/^upstream-[AB]$/);
  });

  test("the websocket tunnel echoes through the upstream", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws/echo");
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
      ws.send("hello");
    });
    expect(reply).toBe("echo from upstream-A: hello");
    ws.close();
  });
});
