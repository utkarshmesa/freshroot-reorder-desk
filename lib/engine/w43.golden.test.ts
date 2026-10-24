// RU-01: case data, week 2026-W43, D18 defaults, no open POs → data/reference/expected_2026-W43.json, exactly.
// Values are compared after half-to-even rounding to 2 dp (C-012); action, qty, flags, triage, min_eff and max exactly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseInput } from "@/tests/helpers/engine";
import { runEngine } from "./index";
import { round2 } from "./round";

type Expected = {
  sku_id: string;
  name: string;
  a12: number;
  a4: number;
  forward_demand: number;
  position: number;
  cover_weeks: number;
  min_eff: number;
  max: number;
  action: string;
  qty: number;
  cover_after: number | null;
  flags: string[];
  triage: string;
};

const expected = JSON.parse(readFileSync("data/reference/expected_2026-W43.json", "utf8")) as { run_week: string; results: Expected[] };
const out = runEngine(caseInput());
const bySku = new Map(out.recommendations.map((r) => [r.skuId, r]));

describe("RU-01 W43 reference reproduced exactly", () => {
  it("covers all 15 SKUs for 2026-W43", () => {
    expect(out.runWeek).toBe(expected.run_week);
    expect([...bySku.keys()].sort()).toEqual(expected.results.map((e) => e.sku_id).sort());
  });

  for (const e of expected.results) {
    it(`${e.sku_id} ${e.name}: ${e.action}${e.qty ? ` ${e.qty}` : ""} (${e.triage})`, () => {
      const r = bySku.get(e.sku_id)!;
      expect({
        name: r.name,
        a12: round2(r.a12),
        a4: round2(r.a4),
        forward_demand: round2(r.forwardDemand),
        position: r.position,
        cover_weeks: round2(r.cover!),
        min_eff: r.minEff,
        max: r.max,
        action: r.action,
        qty: r.qty,
        cover_after: r.coverAfter === null ? null : round2(r.coverAfter),
        flags: [...r.flags].sort(),
        triage: r.triage,
      }).toEqual({
        name: e.name,
        a12: e.a12,
        a4: e.a4,
        forward_demand: e.forward_demand,
        position: e.position,
        cover_weeks: e.cover_weeks,
        min_eff: e.min_eff,
        max: e.max,
        action: e.action,
        qty: e.qty,
        cover_after: e.cover_after,
        flags: [...e.flags].sort(),
        triage: e.triage,
      });
    });
  }

  it("names the plan's headline numbers", () => {
    const q = (id: string) => bySku.get(id)!;
    expect([q("SKU013").qty, q("SKU013").triage]).toEqual([240, "auto"]);
    expect([q("SKU003").qty, q("SKU003").triage]).toEqual([600, "auto"]);
    expect([q("SKU001").qty, q("SKU001").triage, q("SKU001").flags]).toEqual([750, "queue", ["high_demand"]]);
    expect([q("SKU011").qty, q("SKU004").qty]).toEqual([561, 219]);
    expect(q("SKU006").action).toBe("pause");
    expect(q("SKU007").action).toBe("pause");
    expect(q("SKU007").flags).toContain("borderline");
    expect(out.recommendations.filter((r) => r.action === "none")).toHaveLength(8);
  });

  it("marks the D18 defaults as assumed on every case SKU", () => {
    for (const r of out.recommendations) {
      expect(r.assumed).toEqual(expect.arrayContaining(["lead_time", "moq", "unit_cost"]));
      expect(r.leadTimeWks).toBe(2);
    }
    expect(bySku.get("SKU004")!.assumed).toContain("shelf_life");
    expect(bySku.get("SKU001")!.assumed).not.toContain("shelf_life");
  });

  it("hides the top-3 distributor view in case-data mode", () => {
    expect(out.recommendations.every((r) => r.topDistributors === null)).toBe(true);
  });

  it("is deterministic: the same input gives the same output", () => {
    expect(runEngine(caseInput())).toEqual(out);
  });
});

describe("stress test F9: the run warns when festival dates run out", () => {
  it("W43 orders stay inside 2026: no warning", () => {
    expect(out.missingFestivalYears).toEqual([]);
    expect(out.notes.some((n) => n.startsWith("No festival dates"))).toBe(false);
  });

  it("orders reaching into 2027 with no 2027 festivals entered: warned", () => {
    const late = runEngine({ ...caseInput(), runWeek: "2026-W52" });
    expect(late.missingFestivalYears).toEqual([2027]);
    expect(late.notes).toContain(
      "No festival dates entered for 2027: orders for those weeks get no festival uplift. Raghav: add them in Settings → Festivals & holds.",
    );
  });
});
