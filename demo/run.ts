// One-command demo runner: boots the mock upstreams and zeroproxy, waits for
// readiness, prints the URL, and stays in the foreground until Ctrl-C.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { styleText } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const PROXY_PORT = 8080;
const DEMO_URL = `http://localhost:${PROXY_PORT}`;
const UPSTREAMS: Array<[port: string, name: string]> = [
  ["9101", "A"],
  ["9102", "B"],
];

const upstreams = UPSTREAMS.map(([port, name]) =>
  spawn("bun", ["demo/upstream.ts", "--port", port, "--name", name], { cwd: ROOT, stdio: "inherit" }),
);
const proxy = spawn("bun", ["run", "src/index.ts", "--config", "demo/demo.config.json", "--root", "demo"], {
  cwd: ROOT,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of [...upstreams, proxy]) child.kill(signal);
  });
}

let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${DEMO_URL}/healthz`)).ok) {
      ready = true;
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(
  ready
    ? styleText("green", `\nDemo ready. Open ${DEMO_URL} in a browser. Ctrl-C stops everything.\n`)
    : styleText("red", `\nzeroproxy did not come up on ${DEMO_URL}; check the output above.\n`),
);

const code = await new Promise<number | null>((resolveExit) => proxy.on("exit", resolveExit));
for (const child of upstreams) child.kill("SIGTERM");
process.exit(code === 0 ? 0 : 1);
