// RU-13 purity and RU-14 property tests: the engine is the only source of quantities, so its invariants
// are checked over many random inputs (deterministic PRNG, so failures reproduce).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addWeeks } from "@/lib/isoweek";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { runEngine } from "./index";
import { roundHalfEven } from "./round";
import { prng } from "./triage";
import type { EngineInput, SkuInput } from "./types";

describe("RU-13 the engine is pure", () => {
  const dir = path.join(process.cwd(), "lib/engine");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it.each(sources)("%s has no I/O, clock, randomness or environment access", (f) => {
    const src = readFileSync(path.join(dir, f), "utf8");
    expect(src).not.toMatch(/\bfetch\(|process\.env|Date\.now|new Date\(\)|Math\.random|supabase|node:fs|"server-only"/);
  });
});

describe("RU-14 invariants over random inputs", () => {
  const rand = prng(20261026);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const N = 400;

  function randomInput(i: number): EngineInput {
    const perishable = rand() < 0.4;
    const s: SkuInput = {
      id: `S${i}`,
      name: "x",
      category: null,
      status: "active",
      firstSaleWeek: null,
      launchEstimateWk: null,
      stdQty: pick([12, 50, 100, 150, 400, 500]),
      moq: pick([null, null, 30, 200, 600]),
      packSize: pick([null, null, 6, 24]),
      leadTimeWks: pick([null, 1, 2, 3]),
      shelfLifeWks: perishable ? pick([null, 6, 8, 12]) : null,
      perishable,
      unitCostInr: null,
      supplierId: "SUP",
    };
    const level = 5 + Math.floor(rand() * 300);
    const trend = pick([1, 1, 1.3, 1.6, 0.7]);
    const weeks = 12 + Math.floor(rand() * 6);
    return {
      runWeek: "2026-W30",
      rules: DEFAULT_RULES,
      caseDataMode: false,
      skus: [s],
      distributors: [{ id: "D1", status: "active", startWeek: null, endWeek: null }],
      events: [],
      sales: Array.from({ length: weeks }, (_, k) => ({
        skuId: s.id,
        distributorId: "D1",
        week: addWeeks("2026-W30", -(weeks - k)),
        shipped: Math.round(level * (k >= weeks - 4 ? trend : 1) * (0.85 + rand() * 0.3)),
        returns: 0,
      })),
      onHand: { [s.id]: Math.floor(rand() * level * 20) },
      stockHistory: {},
      poLines: rand() < 0.3 ? [{ poId: "p", poNumber: "PO", status: "open", skuId: s.id, ordered: Math.floor(rand() * level * 5), received: 0, expectedDate: null }] : [],
      receipts: [],
      holdout: [],
      blocked: {},
      spotCheckSeed: i,
    };
  }

  const cases = Array.from({ length: N }, (_, i) => {
    const input = randomInput(i);
    return { input, r: runEngine(input).recommendations[0]! };
  });

  it(`${N} random SKUs: quantities are whole, non-negative, and only on reorders`, () => {
    for (const { r } of cases) {
      expect(Number.isInteger(r.qty)).toBe(true);
      expect(r.qty).toBeGreaterThanOrEqual(0);
      if (r.action !== "reorder") expect(r.qty).toBe(0);
    }
  });

  it("an uncapped, feasible reorder reaches min_eff cover, respects MOQ and pack size", () => {
    for (const { input, r } of cases) {
      if (r.action !== "reorder" || r.qty === 0 || r.flags.includes("capped_at_perishable_max")) continue;
      expect(r.position + r.qty).toBeGreaterThanOrEqual(r.minEff * r.forwardDemand - 1e-9);
      expect(r.qty).toBeGreaterThanOrEqual(r.moq);
      const pack = input.skus[0]!.packSize;
      if (pack) expect(r.qty % pack).toBe(0);
    }
  });

  it("a perishable order never takes cover above the maximum", () => {
    for (const { r } of cases) {
      if (r.flags.includes("perishable") && r.qty > 0) expect(r.position + r.qty).toBeLessThanOrEqual(r.max * r.forwardDemand + 1e-9);
    }
  });

  it("cover_after = (P + qty) / F whenever something is ordered", () => {
    for (const { r } of cases) {
      if (r.qty > 0) expect(r.coverAfter).toBeCloseTo((r.position + r.qty) / r.forwardDemand, 10);
      else expect(r.coverAfter).toBeNull();
    }
  });

  it("auto items have no flags and stay within 2× std", () => {
    for (const { r } of cases) {
      if (r.triage !== "auto") continue;
      expect(r.flags).toEqual([]);
      expect(r.qty).toBeLessThanOrEqual(2 * r.stdQty);
    }
  });

  it("the random inputs exercise every action and triage (so the checks above aren't vacuous)", () => {
    const seen = new Set(cases.map(({ r }) => `${r.action}/${r.triage}`));
    for (const k of ["reorder/auto", "reorder/queue", "pause/info_no_open_po", "none/none"]) expect(seen).toContain(k);
    expect(cases.some(({ r }) => r.flags.includes("capped_at_perishable_max"))).toBe(true);
    expect(cases.some(({ r }) => r.flags.includes("infeasible"))).toBe(true);
  });
});

describe("half-to-even display rounding (C-012)", () => {
  it.each([
    [188.125, 188.12],
    [74.375, 74.38],
    [151.875, 151.88],
    [104.6875, 104.69],
    [268.6458333, 268.65],
    // Decimal ties are ties even when binary storage lands a hair below .5 (Python would give 2.67 and 3.34).
    [2.675, 2.68],
    [3.345, 3.34],
    [0, 0],
  ])("%s → %s", (x, y) => {
    expect(roundHalfEven(x)).toBe(y);
  });
});
