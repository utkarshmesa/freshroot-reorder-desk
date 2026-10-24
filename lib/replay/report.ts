// Renders the replay results as the gate report (REPLAY_SPEC §4–5). Pure.
import type { ReplaySummary } from "./replay";

const n = (x: number, dp = 0) => x.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp });
const ci = (i: { estimate: number; low: number; high: number }, dp = 0) => `${n(i.estimate, dp)} (95% CI ${n(i.low, dp)} to ${n(i.high, dp)})`;

export type ReportInput = {
  title: string;
  dataNote: string;
  main: ReplaySummary; // production reading ("any"), rules as written ("skip")
  readings: ReplaySummary[]; // all readings, rules as written
  moq: ReplaySummary; // production reading, infeasible cards ordered at MOQ
  qa: { conservation: boolean; negativeStock: boolean; weeksContiguous: boolean; hasW53: boolean };
};

export function renderReport(r: ReportInput): string {
  const m = r.main;
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push(`# ${r.title}`, "", `> ${r.dataNote}`, "");
  push(`**Verdict: ${m.verdict.result}**`, "", ...m.verdict.reasons.map((x) => `- ${x}`), "");
  push(
    `Simulated Mondays: **${m.replayWeeks}** (${m.firstWeek ?? "–"} to ${m.lastWeek ?? "–"}) · SKUs compared: **${m.compared}** of ${m.skus.length} · method: \`docs/REPLAY_SPEC.md\``,
    "",
  );

  push("## 1. Rules vs what actually happened", "", "| Measure | Actual arm | Rules arm | Difference (rules − actual) |", "|---|---|---|---|");
  push(`| Stockout weeks (C-017) | ${n(m.actual.stockoutWeeks)} | ${n(m.rules.stockoutWeeks)} | ${ci(m.diff.stockoutWeeks)} |`);
  push(`| Write-off units | ${n(m.actual.writeOff)} | ${n(m.rules.writeOff)} | ${ci(m.diff.writeOff)} |`);
  push(`| Weeks with lost sales (C-031 proposed) | ${n(m.actual.lostSalesWeeks)} | ${n(m.rules.lostSalesWeeks)} | ${ci(m.diff.lostSalesWeeks)} |`);
  push(`| Weeks with zero stock on Sunday | ${n(m.actual.zeroStockWeeks)} | ${n(m.rules.zeroStockWeeks)} | |`);
  push(`| Lost-sales units | ${n(m.actual.lost)} | ${n(m.rules.lost)} | ${ci(m.diff.lost)} |`);
  push(`| Units ordered / received | ${n(m.actual.unitsOrdered)} | ${n(m.rules.unitsOrdered)} | |`);
  push(`| Orders | ${n(m.actual.orders)} | ${n(m.rules.orders)} | |`, "");
  push("Both arms run through the same simulator with the same demand; only the receipts differ (actual receipts vs the engine's orders). Intervals: 95% bootstrap over SKUs, seeded.", "");

  push("## 2. Per SKU", "", "| SKU | Perishable | Stock source | Stockout wks (actual → rules) | Write-off units (actual → rules) | Imputed weeks | Notes |", "|---|---|---|---|---|---|---|");
  for (const s of m.skus) {
    const a = s.actual;
    const b = s.rules;
    const notes = [s.assumed.length ? `assumed: ${s.assumed.join(", ")}` : "", !a ? "no actual arm" : ""].filter(Boolean).join("; ");
    push(`| ${s.skuId} | ${s.perishable ? `yes (shelf ${s.shelfLifeWks} wks)` : "no"} | ${s.stockSource} | ${a ? n(a.stockoutWeeks) : "–"} → ${b ? n(b.stockoutWeeks) : "–"} | ${a ? n(a.writeOff) : "–"} → ${b ? n(b.writeOff) : "–"} | ${s.stats.imputedWeeks} | ${notes} |`);
  }
  push("");

  push("## 3. Calibration (D6, D8)", "", "### Festival readings (D6)", "", "| Reading | Stockout weeks | Write-off units | Lost units | Units ordered |", "|---|---|---|---|---|");
  for (const x of r.readings) push(`| ${x.reading}${x.reading === "any" ? " (production, C-004)" : x.reading === "literal" ? " (Raghav's rule 4 as written)" : ""} | ${n(x.rules.stockoutWeeks)} | ${n(x.rules.writeOff)} | ${n(x.rules.lost)} | ${n(x.rules.unitsOrdered)} |`);
  push("", "### Infeasible perishable cards", "", "| Policy | Stockout weeks | Write-off units |", "|---|---|---|");
  push(`| Skip (rules as written) | ${n(m.rules.stockoutWeeks)} | ${n(m.rules.writeOff)} |`, `| Order the MOQ (Raghav's usual choice) | ${n(r.moq.rules.stockoutWeeks)} | ${n(r.moq.rules.writeOff)} |`, "");
  const st = m.skus.reduce(
    (a, s) => ({
      reorder: a.reorder + s.stats.reorderWeeks,
      infeasible: a.infeasible + s.stats.infeasibleWeeks,
      borderline: a.borderline + s.stats.borderlineWeeks,
      hdUplift: a.hdUplift + s.stats.hdWithUplift,
      hdBelow: a.hdBelow + s.stats.hdBelowNormal,
    }),
    { reorder: 0, infeasible: 0, borderline: 0, hdUplift: 0, hdBelow: 0 },
  );
  push("### Review load and rule behaviour (D8, C-029)", "");
  push(`- Queue cards per Monday: average **${n(m.load.avgQueue, 1)}**, most **${n(m.load.maxQueue)}**; auto-approved per Monday: **${n(m.load.avgAuto, 1)}** (of which spot-checks ${n(m.load.avgSpotChecks, 1)}).`);
  push(`- Reorder recommendations: ${n(st.reorder)}; perishable infeasible: ${n(st.infeasible)}; borderline: ${n(st.borderline)}.`);
  push(`- High demand stacked on a festival uplift: ${n(st.hdUplift)} SKU-weeks.`);
  push(`- High-demand quantity below the normal quantity (C-029): ${n(st.hdBelow)} SKU-weeks.`, "");

  push("## 4. Method QA (data:validate-data)", "");
  push(`- Units conserved in every simulated arm (opening + receipts = sold + written off + closing): **${r.qa.conservation ? "yes" : "NO"}**`);
  push(`- No negative stock: **${r.qa.negativeStock ? "NO, negative stock found" : "yes"}**`);
  push(`- Weeks contiguous: **${r.qa.weeksContiguous ? "yes" : "NO"}**; includes a W53: ${r.qa.hasW53 ? "yes" : "no (none in this period)"}`);
  const tracked = m.skus.filter((s) => s.qa && s.qa.trackedWeeks > 0);
  if (tracked.length) {
    const avgGap = tracked.reduce((a, s) => a + s.qa!.trackingMeanAbs!, 0) / tracked.length;
    const loss = tracked.reduce((a, s) => a + s.qa!.inferredLossSigned, 0);
    push(`- Actual arm vs real SAP stock: mean absolute gap **${n(avgGap, 1)} units** per SKU-week over ${tracked.length} SKUs; inferred loss in the real history (signed, C-014 option A): **${n(loss)} units**.`);
  } else push("- Actual arm vs real SAP stock: **not checkable**. There is no weekly stock history, so stock was rebuilt (D20) and write-offs come from the simulator's ageing only (C-014 option C).");
  push("");

  push("## 5. Limits", "");
  push("- Approved orders are assumed to arrive exactly after the lead time; supplier delays aren't modelled.");
  push("- Demand doesn't react to an arm's own stockouts (lost customers aren't modelled).");
  push("- Every recommendation is taken as approved at the engine's quantity; the Tuesday deadline isn't modelled.");
  push("- The real age of opening stock isn't known; it is assumed to have arrived evenly over the previous weeks, the same for both arms.");
  push("- The rules count stock that is about to expire as cover (D5 position has no age). Perishable losses from that are real behaviour of the rules, not of the simulator.");
  push("- Perishable shelf life missing from the master is assumed to be 2 × the maximum cover (D18), marked per SKU.");
  return lines.join("\n") + "\n";
}
