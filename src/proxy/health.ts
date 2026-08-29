import type { Balancer } from "./balancer";
import type { HealthCheckConfig } from "../config";

export type HealthChecker = {
  start: () => void;
  stop: () => void;
  checkOnce: () => Promise<void>;
};

// Periodically probes each upstream and tells its balancer whether it is
// healthy. checkOnce is public so tests can drive it without real timers.
export function healthChecker(balancers: Balancer[], cfg: HealthCheckConfig): HealthChecker {
  let timer: ReturnType<typeof setInterval> | undefined;
  const checks = new Map<Balancer, string[]>();

  for (const balancer of balancers) {
    checks.set(balancer, balancer.rotate());
  }

  const probe = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url + cfg.path, {
        method: "GET",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      return res.status >= 200 && res.status < 500;
    } catch {
      return false;
    }
  };

  const checkOnce = async (): Promise<void> => {
    const tasks: Promise<void>[] = [];
    for (const [balancer, urls] of checks) {
      for (const url of urls) {
        tasks.push(probe(url).then((ok) => balancer.mark(url, ok)));
      }
    }
    await Promise.all(tasks);
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      void checkOnce();
    }, cfg.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return { start, stop, checkOnce };
}
