// D9 / C-008: min(5, number of auto items) auto-approved items are also shown to Raghav as spot-checks.
// Deterministic: the seed is stored on the run (RN-05).
import type { Recommendation } from "./types";

/** mulberry32: small, fast, deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function assignSpotChecks(recs: Recommendation[], seed: number, count: number): Recommendation[] {
  const auto = recs.filter((r) => r.triage === "auto" && !r.holdout).map((r) => r.skuId).sort();
  const rand = prng(seed);
  for (let i = auto.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [auto[i], auto[j]] = [auto[j]!, auto[i]!];
  }
  const picked = new Set(auto.slice(0, Math.min(count, auto.length)));
  return recs.map((r) => (picked.has(r.skuId) ? { ...r, spotCheck: true } : r));
}
