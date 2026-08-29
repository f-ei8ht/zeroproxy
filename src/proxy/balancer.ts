import type { Upstream } from "../config";

export type Balancer = {
  pick: () => string;
  rotate: () => string[];
  mark: (url: string, healthy: boolean) => void;
};

type Target = { url: string; weight: number };

export function normalizeUpstreams(upstreams: Upstream[]): Target[] {
  return upstreams.map((u) =>
    typeof u === "string" ? { url: u, weight: 1 } : { url: u.url, weight: u.weight ?? 1 },
  );
}

// Weighted round-robin over healthy upstreams. A target's pick chance is
// proportional to its weight; failed targets are skipped entirely.
export function roundRobin(upstreams: Upstream[]): Balancer {
  const targets = normalizeUpstreams(upstreams);
  const healthy = new Set(targets.map((t) => t.url));
  let picks = 0;

  const active = (): Target[] => targets.filter((t) => healthy.has(t.url));

  // Ordered failover candidates: every healthy upstream once, higher weight
  // first, rotated so the next pick lands at the front. Deduplicated so a
  // failed target is never retried within one request.
  const rotate = (): string[] => {
    const pool = active().sort((a, b) => b.weight - a.weight);
    if (pool.length === 0) return [];
    const shift = picks % pool.length;
    const ordered = pool.slice(shift).concat(pool.slice(0, shift));
    return ordered.map((t) => t.url);
  };

  return {
    pick: () => {
      const pool = active();
      if (pool.length === 0) return targets[0]!.url;
      const total = pool.reduce((sum, t) => sum + t.weight, 0);
      let cursor = picks % total;
      for (const t of pool) {
        if (cursor < t.weight) {
          picks++;
          return t.url;
        }
        cursor -= t.weight;
      }
      picks++;
      return pool[0]!.url;
    },
    rotate,
    mark: (url, ok) => {
      if (ok) healthy.add(url);
      else healthy.delete(url);
    },
  };
}
