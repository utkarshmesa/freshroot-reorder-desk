// LL-01..LL-06 (BUILD_PLAN §13 "Claude"; ARCHITECTURE §6): Claude only explains, every number is checked.
import { describe, expect, it } from "vitest";
import { briefTemplate, reasonTemplate } from "./template";
import { checkNumbers, extractNumbers } from "./numbers";
import { allowlist, briefPrompt, reasonPrompt, type BriefFacts, type CardFacts } from "./prompt";
import { explainBrief, explainCard, type LlmCall } from "./explain";

const card = (o: Partial<CardFacts> = {}): CardFacts => ({
  skuId: "SKU004",
  name: "Mango Drink 200ml",
  action: "reorder",
  qty: 750,
  cover: 2.8,
  coverAfter: 6.6,
  flags: ["high_demand"],
  assumed: ["lead_time", "moq"],
  a12: 180,
  a4: 230,
  forwardDemand: 180,
  position: 500,
  minEff: 6,
  max: 14,
  leadTimeWks: 2,
  moq: 500,
  stdQty: 500,
  festivalFactor: 1,
  onHand: 500,
  openPoQty: 0,
  daysToStockout: 19.4,
  infeasibleOptions: null,
  blockedReason: null,
  topDistributors: [
    { code: "D1", deltaUnits: 120, pct: 52 },
    { code: "D2", deltaUnits: 60, pct: 26 },
  ],
  ...o,
});
const names = { D1: "Sharma Traders", D2: "Patel & Sons" };

describe("number checker (ARCHITECTURE §6)", () => {
  it("reads Indian-format numbers, decimals, percents and lakhs", () => {
    expect(extractNumbers("Order 1,200 units (6.6 wks, +25%), ₹1.2L")).toEqual([
      { value: 1200, dp: 0, pct: false },
      { value: 6.6, dp: 1, pct: false },
      { value: 25, dp: 0, pct: true },
      { value: 120000, dp: 0, pct: false },
    ]);
  });

  it("ignores identifiers: SKU codes, D1–D3, ISO weeks, FR- references and the SKU name", () => {
    expect(extractNumbers("SKU004 Mango Drink 200ml for D2 in 2026-W43, see FR-2026-W43-DIST003", ["Mango Drink 200ml"])).toEqual([]);
  });

  it("passes when every number is in the card's allowlist at the precision written", () => {
    const allow = allowlist(card());
    expect(checkNumbers("Cover is 2.8 weeks; 750 units bring it to 6.6, above the 6-week minimum.", allow).ok).toBe(true);
    expect(checkNumbers("Recent sales are 28% above the 12-week average.", allow).ok).toBe(true); // 230/180 − 1 = 27.8% → 28
  });

  it("fails on any number not in the allowlist: no free pass for small numbers", () => {
    const allow = allowlist(card());
    const r = checkNumbers("Order 900 units to cover 9 weeks.", allow); // (2.8 written as "3" would pass: a rounding of an engine value)
    expect(r.ok).toBe(false);
    expect(r.unmatched).toEqual(["900", "9"]);
  });
});

describe("prompts carry numbers and codes only (privacy)", () => {
  it("no distributor names or ids in the card prompt", () => {
    const p = reasonPrompt(card());
    expect(p).not.toMatch(/Sharma|Patel|DIST/);
    expect(p).toContain("D1");
  });

  it("no distributor names in the brief prompt", () => {
    const p = briefPrompt(brief());
    expect(p).not.toMatch(/Sharma|Patel|DIST/);
  });
});

const brief = (o: Partial<BriefFacts> = {}): BriefFacts => ({
  isoWeek: "2026-W43",
  mode: "shadow",
  autoLines: 2,
  autoUnits: 840,
  queueLines: 5,
  queueUnits: 1530,
  pauses: 2,
  blocked: 0,
  atRisk: [{ skuId: "SKU004", name: "Mango Drink 200ml", daysToStockout: 19.4 }],
  needsDeepa: [],
  ...o,
});

describe("explainCard: LLM text only when it checks out", () => {
  it("uses the LLM text when every number matches, with names put back afterwards", async () => {
    const llm: LlmCall = async () => "Sales via D1 are up; 750 units lift cover from 2.8 to 6.6 weeks.";
    const r = await explainCard(card(), llm, names);
    expect(r).toEqual({ source: "llm", text: "Sales via Sharma Traders are up; 750 units lift cover from 2.8 to 6.6 weeks." });
  });

  it("LL-01: an outage falls back to the template", async () => {
    const llm: LlmCall = async () => {
      throw new Error("503");
    };
    const r = await explainCard(card(), llm, names);
    expect(r.source).toBe("template");
    expect(r.text).toBe(reasonTemplate(card(), names));
  });

  it("LL-02: a number mismatch falls back to the template, and the quantity is never read from the text", async () => {
    const c = card();
    const r = await explainCard(c, async () => "Order 900 units instead.", names);
    expect(r.source).toBe("template");
    expect(c.qty).toBe(750);
    expect(r.text).not.toContain("900");
  });

  it("no LLM configured → template", async () => {
    expect((await explainCard(card(), null, names)).source).toBe("template");
  });

  it("empty or overlong replies fall back", async () => {
    expect((await explainCard(card(), async () => "  ", names)).source).toBe("template");
    expect((await explainCard(card(), async () => "x ".repeat(400), names)).source).toBe("template");
  });

  it("case-data mode hides names: codes stay as written", async () => {
    const r = await explainCard(card(), async () => "D1 drives the rise; 750 units.", null);
    expect(r.text).toBe("D1 drives the rise; 750 units.");
  });
});

describe("templates (deterministic, every action)", () => {
  it("reorder with high demand", () => {
    expect(reasonTemplate(card(), names)).toBe(
      "Cover is 2.8 weeks against a minimum of 6; ordering 750 units brings it to 6.6 weeks. Recent sales (230 a week) are above the 12-week average (180), mostly via Sharma Traders.",
    );
  });

  it("infeasible perishable shows both choices", () => {
    const t = reasonTemplate(
      card({ action: "reorder", qty: 0, flags: ["perishable", "infeasible"], max: 4, minEff: 4, infeasibleOptions: { orderMoq: { qty: 500, coverAfter: 5.5 }, skip: { daysToStockout: 9.1 } } }),
      null,
    );
    expect(t).toContain("Order the MOQ of 500 (cover 5.5 weeks, above the 4-week maximum) or skip (about 9 days to stockout).");
  });

  it("pause, none and blocked", () => {
    expect(reasonTemplate(card({ action: "pause", qty: 0, cover: 16.2, flags: [] }), null)).toBe("Cover is 16.2 weeks, above the 14-week maximum: no new order this week.");
    expect(reasonTemplate(card({ action: "none", qty: 0, cover: 8, flags: [] }), null)).toBe("Cover is 8.0 weeks, inside the 6–14 week band: no order needed.");
    expect(reasonTemplate(card({ action: "blocked", qty: 0, cover: null, flags: [], blockedReason: "No Zoho item mapped" }), null)).toBe("Blocked: No Zoho item mapped.");
  });

  it("every template passes its own number check", () => {
    for (const c of [card(), card({ action: "pause", cover: 16.2, flags: ["conflict", "high_demand"] }), card({ action: "none", cover: 8, flags: ["borderline"] })]) {
      const t = reasonTemplate(c, null);
      expect(checkNumbers(t, allowlist(c), [c.name]).ok).toBe(true);
    }
  });
});

describe("LL-04: a brief every run", () => {
  it("template brief when the LLM is down", async () => {
    const r = await explainBrief(brief(), async () => {
      throw new Error("down");
    });
    expect(r.source).toBe("template");
    expect(r.text).toBe(briefTemplate(brief()));
    expect(r.text).toContain("2 lines (840 units) auto-approved");
  });

  it("LLM brief when its numbers check", async () => {
    const r = await explainBrief(brief(), async () => "Week 2026-W43: 2 lines auto-approved, 5 cards for Raghav; Mango Drink 200ml has about 19 days of stock.");
    expect(r.source).toBe("llm");
  });

  it("brief with an invented number falls back", async () => {
    const r = await explainBrief(brief(), async () => "We saved ₹3L this week.");
    expect(r.source).toBe("template");
  });
});

describe("review M5 finding 6: a number must be used for what it is", () => {
  it("an engine number in the wrong role (the MOQ said as the order) falls back", async () => {
    const r = await explainCard(card(), async () => "Order 500 units now.", null); // 500 is the MOQ, the order is 750
    expect(r.source).toBe("template");
  });
  it("the right order quantity passes", async () => {
    expect((await explainCard(card(), async () => "Ordering 750 units restores cover.", null)).source).toBe("llm");
  });
  it("quantities in words can't be checked and fall back", async () => {
    expect((await explainCard(card(), async () => "Sales have doubled; order twice the usual.", null)).source).toBe("template");
    expect((await explainBrief(brief(), async () => "Two hundred units auto-approved.")).source).toBe("template");
  });
  it("on an infeasible card, ordering the MOQ is one of the card's own choices", async () => {
    const c = card({ qty: 0, flags: ["perishable", "infeasible"], infeasibleOptions: { orderMoq: { qty: 500, coverAfter: 5.5 }, skip: { daysToStockout: 9.1 } } });
    expect((await explainCard(c, async () => "Either order 500 units or skip this week.", null)).source).toBe("llm");
  });
});
