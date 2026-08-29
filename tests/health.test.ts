import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { healthChecker } from "../src/proxy/health";
import { roundRobin } from "../src/proxy/balancer";

let upstream: ReturnType<typeof Bun.serve>;
let upstreamUrl: string;

beforeAll(() => {
  upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  upstreamUrl = `http://localhost:${upstream.port}`;
});

afterAll(() => {
  upstream.stop(true);
});

const CFG = { intervalMs: 5000, timeoutMs: 1000, path: "/" };

describe("healthChecker", () => {
  test("marks a live upstream healthy", async () => {
    const balancer = roundRobin([upstreamUrl]);
    const checker = healthChecker([balancer], CFG);
    await checker.checkOnce();
    expect(balancer.rotate()).toContain(upstreamUrl);
  });

  test("marks a dead upstream unhealthy and removes it from rotation", async () => {
    const balancer = roundRobin(["http://127.0.0.1:1", upstreamUrl]);
    const checker = healthChecker([balancer], CFG);
    await checker.checkOnce();
    const rot = balancer.rotate();
    expect(rot).toContain(upstreamUrl);
    expect(rot).not.toContain("http://127.0.0.1:1");
  });

  test("start and stop manage a timer without error", () => {
    const balancer = roundRobin([upstreamUrl]);
    const checker = healthChecker([balancer], CFG);
    checker.start();
    checker.start();
    checker.stop();
    checker.stop();
  });
});
