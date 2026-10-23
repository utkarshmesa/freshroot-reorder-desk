// Triage (D8, D9, D16, C-001, C-002, C-008) and the Tuesday 12:00 rule (TR-01…03, ST-03, RN-10).
import { describe, expect, it } from "vitest";
import { addWeeks } from "@/lib/isoweek";
import { oneSku } from "@/tests/helpers/engine";
import { applyDeadline } from "./deadline";
import { runEngine } from "./index";
import type { EngineInput, SkuInput } from "./types";

const flat = (n: number, u: number) => Array<number>(n).fill(u);

// std 300, demand 100/wk, on hand 100 → needs 600 (= 2× std): a routine auto-approve.
const routineSku: Partial<SkuInput> = { stdQty: 300 };

function many(ids: string[], onHand: Record<string, number>, weekly: (id: string) => number[], over: (id: string) => Partial<SkuInput> = () => ({}), seed = 42): EngineInput {
  const base = oneSku(routineSku, flat(12, 100));
  return {
    ...base,
    skus: ids.map((id) => ({ ...base.skus[0]!, id, ...over(id) })),
    sales: ids.flatMap((id) => weekly(id).map((u, i) => ({ skuId: id, distributorId: "D1", week: addWeeks(base.runWeek, -(12 - i)), shipped: u, returns: 0 }))),
    onHand,
    spotCheckSeed: seed,
  };
}
const routine = (n: number, seed = 42) => {
  const ids = Array.from({ length: n }, (_, i) => `R${String(i).padStart(2, "0")}`);
  return many(ids, Object.fromEntries(ids.map((id) => [id, 100])), () => flat(12, 100), () => ({}), seed);
};

describe("TR-01 auto-approve criteria exact (D8 + C-002 + D16)", () => {
  const one = (sku: Partial<SkuInput>, weekly: number[], over: Partial<EngineInput> = {}) =>
    runEngine(oneSku({ ...routineSku, ...sku }, weekly, { onHand: { S1: 100 }, ...over })).recommendations[0]!;

  it("routine non-perishable reorder → auto", () => {
    const r = one({}, flat(12, 100));
    expect([r.action, r.qty, r.triage, r.flags]).toEqual(["reorder", 600, "auto", []]);
  });

  it.each([
    ["perishable", { perishable: true }, flat(12, 100), {}],
    ["high demand", {}, [...flat(8, 100), ...flat(4, 150)], {}],
    ["new SKU", { firstSaleWeek: addWeeks("2026-W30", -6), launchEstimateWk: 100 }, flat(6, 100), {}],
    ["borderline", {}, flat(12, 100), { onHand: { S1: 590 } }],
  ] as Array<[string, Partial<SkuInput>, number[], Partial<EngineInput>]>)("%s → queue", (_, sku, weekly, over) => {
    const r = one(sku, weekly, over);
    expect(r.action).toBe("reorder");
    expect(r.triage).toBe("queue");
  });

  it("ST-03 auto qty over 2× std goes to the queue", () => {
    const r = one({ stdQty: 100 }, flat(12, 100), { onHand: { S1: 0 } }); // needs 600 = 6× std
    expect(r.qty).toBe(600);
    expect(r.flags).toContain("over_auto_limit");
    expect(r.triage).toBe("queue");
  });

  it("C-001 pause with no open PO is informational; with open PO lines it is queued", () => {
    expect(one({}, flat(12, 100), { onHand: { S1: 3000 } }).triage).toBe("info_no_open_po");
    const withPo = one({}, flat(12, 100), {
      onHand: { S1: 3000 },
      poLines: [{ poId: "p", poNumber: "PO-7", status: "open", skuId: "S1", ordered: 500, received: 0, expectedDate: null }],
    });
    expect(withPo.triage).toBe("queue");
    expect(withPo.openPoLines).toEqual([{ poNumber: "PO-7", openQty: 500, expectedDate: null, overdue: false }]);
  });

  it("an overdue open PO line sends the SKU to the queue (C-026)", () => {
    const r = one({}, flat(12, 100), {
      onHand: { S1: 100 },
      poLines: [{ poId: "p", poNumber: "PO-8", status: "open", skuId: "S1", ordered: 100, received: 0, expectedDate: "2026-07-01" }],
    });
    expect(r.flags).toContain("overdue_po");
    expect(r.triage).toBe("queue");
  });

  it("holdout SKUs are computed but never triaged for ordering", () => {
    const r = one({}, flat(12, 100), { holdout: ["S1"] });
    expect([r.holdout, r.triage]).toEqual([true, "none"]);
  });
});

describe("TR-02 spot-checks (D9, C-008)", () => {
  const spot = (input: EngineInput) => runEngine(input).recommendations.filter((r) => r.spotCheck).map((r) => r.skuId);

  it("5 of 12 auto items become spot-checks: the same 5 for the same seed, others for another seed", () => {
    const a = spot(routine(12));
    expect(a).toHaveLength(5);
    expect(spot(routine(12))).toEqual(a);
    expect(spot(routine(12, 7))).not.toEqual(a);
  });

  it("with only 2 auto items, both are spot-checked; they stay auto (D9 adds them to the queue as samples)", () => {
    expect(spot(routine(2))).toHaveLength(2);
    expect(runEngine(routine(2)).recommendations.map((r) => r.triage)).toEqual(["auto", "auto"]);
  });

  it("only auto items are spot-checked", () => {
    const out = runEngine(many(["A", "Q"], { A: 100, Q: 590 }, () => flat(12, 100))).recommendations;
    expect(out.filter((r) => r.spotCheck).map((r) => r.skuId)).toEqual(["A"]);
  });
});

describe("TR-03 Tuesday 12:00 rule (pure part) and RN-10", () => {
  // NP: non-perishable, cover 5.9 < 6 and borderline → queued, a stockout risk.
  // PER: perishable → queued. HD: high demand with cover 8.6 ≥ 6 → queued, but not a stockout risk.
  const out = runEngine(
    many(["NP", "PER", "HD"], { NP: 590, PER: 100, HD: 1000 }, (id) => (id === "HD" ? [...flat(8, 100), ...flat(4, 150)] : flat(12, 100)), (id) => (id === "PER" ? { perishable: true } : {})),
  ).recommendations;
  const by = (id: string) => out.find((r) => r.skuId === id)!;

  it("all three start in the queue", () => {
    expect(out.map((r) => r.triage)).toEqual(["queue", "queue", "queue"]);
  });

  it("unreviewed non-perishable stockout risks → deadline_auto at 1× std; the rest roll to next week", () => {
    const states = Object.fromEntries(applyDeadline(out.map((rec) => ({ rec, state: "queued" as const })), { deadlineStdMultiple: 1 }).map((s) => [s.skuId, s]));
    expect(states.NP).toMatchObject({ state: "deadline_auto", qty: 300 });
    expect(states.PER).toMatchObject({ state: "rolled", qty: 0 });
    expect(states.HD).toMatchObject({ state: "rolled", qty: 0 });
  });

  it("RN-10 an unreviewed spot-check keeps its auto qty", () => {
    const [s] = applyDeadline([{ rec: { ...by("NP"), triage: "auto", spotCheck: true, qty: 600 }, state: "queued" }], { deadlineStdMultiple: 1 });
    expect(s).toMatchObject({ state: "deadline_auto", qty: 600 });
  });

  it("the deadline quantity is rounded up to the pack size (review finding 9)", () => {
    const [s] = applyDeadline([{ rec: { ...by("NP"), packSize: 24 }, state: "queued" }], { deadlineStdMultiple: 1 });
    expect(s).toMatchObject({ state: "deadline_auto", qty: 312 }); // 300 → 13 packs of 24
  });

  it("decided lines are left alone", () => {
    const [s] = applyDeadline([{ rec: by("PER"), state: "approved" }], { deadlineStdMultiple: 1 });
    expect(s!.state).toBe("approved");
  });
});
