// ST-07 (unit part): every ⚙ value in docs/INSTRUCTIONS.md is bound to the live rules, every binding names a
// real rule, and the defaults written in the document match the seeded rules (BUILD_PLAN §10.5).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { bindInstructions, bindings, headingId } from "./bind";

const DOC = readFileSync("docs/INSTRUCTIONS.md", "utf8");

describe("INSTRUCTIONS.md bindings", () => {
  it("every line with ⚙ has at least one binding (the page can't disagree with the engine)", () => {
    const unbound = DOC.split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes("⚙") && !/\{\{[^}]+\}\}/.test(line) && !line.includes("Numbers marked ⚙"));
    expect(unbound.map((u) => `line ${u.n}: ${u.line.slice(0, 80)}`)).toEqual([]);
  });

  it("every binding names a rule that exists, and its written default is today's seeded value", () => {
    const all = bindings(DOC);
    expect(all.length).toBeGreaterThan(20);
    for (const b of all) {
      const r = bindInstructions(`{{${b.raw}}}`, DEFAULT_RULES);
      expect(r.errors, b.raw).toEqual([]);
      expect(r.text, b.raw).toBe(b.fallback);
    }
  });

  it("a changed rule shows on the page (HD threshold 20% → 25%)", () => {
    const before = bindInstructions(DOC, DEFAULT_RULES).text;
    const after = bindInstructions(DOC, { ...DEFAULT_RULES, highDemandRatio: 1.25 }).text;
    expect(before).toContain("more than **20% ⚙** above the 12-week average");
    expect(after).toContain("more than **25% ⚙** above the 12-week average");
    expect(after).not.toMatch(/\{\{/);
  });
});

describe("bindInstructions", () => {
  const p = { ...DEFAULT_RULES, festivalUpliftPct: 30, newSku: { launchEstimateWks: 4, blendUntilWk: 10 } };
  it("formats numbers, the high-demand ratio as a percentage, and +1 offsets", () => {
    expect(bindInstructions("+{{festivalUpliftPct=25}}%", p).text).toBe("+30%");
    expect(bindInstructions("{{highDemandRatio|pct=20}}%", { ...p, highDemandRatio: 1.2 }).text).toBe("20%");
    expect(bindInstructions("from week {{newSku.blendUntilWk|+1=13}}", p).text).toBe("from week 11");
    expect(bindInstructions("×{{highDemandMultiplier=1.5}}", p).text).toBe("×1.5");
  });

  it("an unknown rule keeps the written default and reports it", () => {
    const r = bindInstructions("{{noSuchRule=7}} weeks", p);
    expect(r.text).toBe("7 weeks");
    expect(r.errors).toEqual(["noSuchRule"]);
  });

  it("bound values are HTML-escaped", () => {
    const r = bindInstructions("{{deadline.timeIST=12:00}}", { ...p, deadline: { weekday: "TUE", timeIST: "<b>x</b>" } });
    expect(r.text).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("heading ids (links from cards and validation errors)", () => {
  it("numbered sections get stable ids", () => {
    expect(headingId("6. What to do when…")).toBe("what-to-do-when");
    expect(headingId("5. Assumptions (what the system takes as true)")).toBe("assumptions");
    expect(headingId("Uploader (Priya)")).toBe("uploader-priya");
    expect(headingId("Head of Operations (Deepa)")).toBe("head-of-operations-deepa");
  });
});

describe("renderInstructions", () => {
  it("renders the document with section ids, live values and marked ⚙ values", async () => {
    const { renderInstructions } = await import("./render");
    const { html, errors } = renderInstructions(DOC, { ...DEFAULT_RULES, festivalUpliftPct: 30 });
    expect(errors).toEqual([]);
    for (const id of ["assumptions", "what-to-do-when", "uploader-priya", "planner-raghav", "rules", "words"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("+30%");
    expect(html).toContain('<span class="gear"');
    expect(html).toContain("<table>");
    expect(html).not.toContain("{{");
  });

  it("raw HTML in the source is shown as text, not run", async () => {
    const { renderInstructions } = await import("./render");
    expect(renderInstructions("Hello <script>alert(1)</script>", DEFAULT_RULES).html).not.toContain("<script>");
  });
});
