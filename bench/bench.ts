// A zero-dependency load test. Spawns zeroproxy serving ./public, fires a
// fixed number of requests with C concurrent workers, and reports throughput
// and latency percentiles. Replaces what most people run autocannon for.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const CONCURRENCY = Number(process.env.BENCH_C ?? "32");
const REQUESTS = Number(process.env.BENCH_N ?? "20000");
const PORT = 9898;
const TARGET = "/static/index.html";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function worker(url: string, latencies: number[], count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const res = await fetch(url);
    await res.arrayBuffer();
    latencies.push(performance.now() - start);
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const config = {
    port: PORT,
    routes: [{ pattern: "/static/*", static: "./public" }],
  };
  await Bun.write(resolve(cwd, ".bench-config.json"), JSON.stringify(config));
  const child = spawn("bun", ["run", "src/index.ts", "--config", ".bench-config.json"], {
    cwd,
    stdio: "ignore",
  });

  await new Promise((r) => setTimeout(r, 1200));
  const url = `http://localhost:${PORT}${TARGET}`;

  const latencies: number[] = [];
  const perWorker = Math.ceil(REQUESTS / CONCURRENCY);
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(url, latencies, perWorker)));
  const elapsedMs = performance.now() - started;
  const actual = Math.min(REQUESTS, latencies.length);

  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`target        ${TARGET}`);
  console.log(`requests      ${actual} (concurrency ${CONCURRENCY})`);
  console.log(`time          ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`throughput    ${Math.round((actual / (elapsedMs / 1000))).toLocaleString()} req/s`);
  console.log(`p50           ${percentile(sorted, 50).toFixed(2)}ms`);
  console.log(`p90           ${percentile(sorted, 90).toFixed(2)}ms`);
  console.log(`p99           ${percentile(sorted, 99).toFixed(2)}ms`);
  console.log(`max           ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms`);

  child.kill("SIGTERM");
  await Bun.write(resolve(cwd, ".bench-config.json"), "");
  process.exit(0);
}

main();
