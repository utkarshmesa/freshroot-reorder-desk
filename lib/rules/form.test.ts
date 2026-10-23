import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "./defaults";
import { applyRuleForm, getPath, RULE_FIELDS } from "./form";

const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });

describe("rule form", () => {
  it("every editable field exists in the defaults", () => {
    for (const f of RULE_FIELDS) expect(typeof getPath(DEFAULT_RULES, f.path), f.path).toBe("number");
  });

  it("changes only what was edited and reports it", () => {
    const r = applyRuleForm(DEFAULT_RULES, form({ highDemandRatio: "1.25", festivalUpliftPct: "25" }));
    expect(r.ok && r.changed).toEqual(["High demand: last 4 weeks above the 12-week average by more than"]);
    expect(r.ok && r.params.highDemandRatio).toBe(1.25);
    expect(DEFAULT_RULES.highDemandRatio).toBe(1.2); // input not mutated
  });

  it("rejects out-of-range, non-integer and inconsistent values", () => {
    expect(applyRuleForm(DEFAULT_RULES, form({ highDemandRatio: "9" })).ok).toBe(false);
    expect(applyRuleForm(DEFAULT_RULES, form({ spotChecks: "2.5" })).ok).toBe(false);
    expect(applyRuleForm(DEFAULT_RULES, form({ "bands.nonPerishable.minWks": "20" })).ok).toBe(false);
    expect(applyRuleForm(DEFAULT_RULES, form({ "rejectionAlarm.lowPct": "50" })).ok).toBe(false);
  });
});
