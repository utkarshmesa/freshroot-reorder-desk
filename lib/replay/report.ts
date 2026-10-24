// Renders the replay results as the gate report (REPLAY_SPEC §4–6). Pure.
import type { ReplaySummary, Verdict } from "./replay";
import { MAX_TRACKING_GAP, MAX_UNEXPLAINED_GAIN } from "./replay";

const n = (x: number, dp = 0) => x.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp });
const ci = (i: { estimate: number; low: number; high: number }, dp = 0) => `${n(i.estimate, dp)} (95% CI ${n(i.low, dp)} to ${n(i.high, dp)})`;
const pct = (x: number) => `${n(x * 100, 1)}%`;

export type PolicyRun = { main: ReplaySummary; late: ReplaySummary; verdict: Verdict };

export type ReportInput = {
  title: string;
  dataNote: string;
  /** The headline: the infeasible-card policy chosen for the gate (C-033 item 3). */
  headline: PolicyRun;
  /** The same run under the other policy, shown for comparison. */
  other: PolicyRun;
  readings: ReplaySummary[]; // all festival readings, headline policy
  qa: { conservation: boolean; missingWeeks: string[]; w53: string; stockRebuilt: number };
};

const policyName = (s: ReplaySummary) => (s.infeasible === "skip" ? "skip (rules as written)" : "order the MOQ");

export function renderReport(r: ReportInput): string {
  const m = r.headline.main;
  const late = r.headline.late;
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push(`# ${r.title}`, "", `> ${r.dataNote}`, "");
  push(`**Verdict: ${r.headline.verdict.result}** (infeasible perishable cards: ${policyName(m)})`, "", ...r.headline.verdict.reasons.map((x) => `- ${x}`), "");
  push(`Under the other policy (${policyName(r.other.main)}) the verdict would be **${r.other.verdict.result}**.`, "");
  push(
    `Simulated Mondays: **${m.replayWeeks}** (${m.firstWeek ?? "–"} to ${m.lastWeek ?? "–"}) · SKUs compared: **${m.compared}** of ${m.skus.length} · method: \`docs/REPLAY_SPEC.md\``,
    "",
  );

  push("## 1. Rules vs what actually happened", "", "| Measure | Actual arm | Rules arm | Difference (rules − actual) | Same, resampling suppliers (check) |", "|---|---|---|---|---|");
  push(`| **Stockout weeks (C-031: empty shelf or lost sales)** | ${n(m.actual.stockoutWeeks)} | ${n(m.rules.stockoutWeeks)} | ${ci(m.diff.stockoutWeeks)} | ${ci(m.diffBySupplier.stockoutWeeks)} |`);
  push(`| **Write-off units** | ${n(m.actual.writeOff)} | ${n(m.rules.writeOff)} | ${ci(m.diff.writeOff)} | ${ci(m.diffBySupplier.writeOff)} |`);
  push(`| Low-cover weeks (C-017, warning only) | ${n(m.actual.lowCoverWeeks)} | ${n(m.rules.lowCoverWeeks)} | ${ci(m.diff.lowCoverWeeks)} | |`);
  push(`| Weeks with lost sales (≥ 1 unit) | ${n(m.actual.lostSalesWeeks)} | ${n(m.rules.lostSalesWeeks)} | ${ci(m.diff.lostSalesWeeks)} | |`);
  push(`| Weeks with zero stock on Sunday | ${n(m.actual.zeroStockWeeks)} | ${n(m.rules.zeroStockWeeks)} | | |`);
  push(`| Lost-sales units | ${n(m.actual.lost)} | ${n(m.rules.lost)} | ${ci(m.diff.lost)} | |`);
  push(`| Average on-hand units (sum over SKUs) | ${n(m.actual.avgOnHand)} | ${n(m.rules.avgOnHand)} | | |`);
  push(`| Units ordered / received | ${n(m.actual.unitsOrdered)} | ${n(m.rules.unitsOrdered)} | | |`);
  push(`| Orders | ${n(m.actual.orders)} | ${n(m.rules.orders)} | | |`, "");
  push(`**Late-delivery check:** with every rules-arm delivery a week late, stockout weeks ${n(late.rules.stockoutWeeks)}, write-off units ${n(late.rules.writeOff)} (verdict on its own: ${late.verdict.result}).`, "");
  push(`Suppliers in the comparison: ${m.suppliers}. Both arms run through the same simulator with the same demand; only the receipts differ (actual receipts vs the engine's orders). Intervals: 95% bootstrap, seeded.`, "");

  push("## 2. Per SKU", "", "| SKU | Perishable | Stock source | Stockout wks (actual → rules) | Write-off units (actual → rules) | Imputed weeks | Notes |", "|---|---|---|---|---|---|---|");
  for (const s of m.skus) {
    const a = s.actual;
    const b = s.rules;
    const notes = [s.excluded ? `**left out: ${s.excluded.replace(/_/g, " ")}**` : "", s.assumed.length ? `assumed: ${s.assumed.join(", ")}` : "", !a ? "no actual arm" : ""].filter(Boolean).join("; ");
    push(`| ${s.skuId} | ${s.perishable ? `yes (shelf ${s.shelfLifeWks} wks)` : "no"} | ${s.stockSource} | ${a ? n(a.stockoutWeeks) : "–"} → ${b ? n(b.stockoutWeeks) : "–"} | ${a ? n(a.writeOff) : "–"} → ${b ? n(b.writeOff) : "–"} | ${s.stats.imputedWeeks} | ${notes} |`);
  }
  push("");

  push("## 3. Calibration (D6, D8)", "", "### Festival readings (D6)", "", "| Reading | Stockout weeks | Write-off units | Lost units | Units ordered |", "|---|---|---|---|---|");
  for (const x of r.readings) push(`| ${x.reading}${x.reading === "any" ? " (production, C-004)" : x.reading === "literal" ? " (Raghav's rule 4 as written)" : ""} | ${n(x.rules.stockoutWeeks)} | ${n(x.rules.writeOff)} | ${n(x.rules.lost)} | ${n(x.rules.unitsOrdered)} |`);
  push("", "### Infeasible perishable cards (C-033 item 3)", "", "| Policy | Stockout weeks | Write-off units | Verdict |", "|---|---|---|---|");
  const [skip, moq] = m.infeasible === "skip" ? [r.headline, r.other] : [r.other, r.headline];
  push(`| Skip (rules as written) | ${n(skip.main.rules.stockoutWeeks)} | ${n(skip.main.rules.writeOff)} | ${skip.verdict.result} |`, `| Order the MOQ | ${n(moq.main.rules.stockoutWeeks)} | ${n(moq.main.rules.writeOff)} | ${moq.verdict.result} |`, "");
  const st = m.skus.reduce(
    (a, s) => ({
      reorder: a.reorder + s.stats.reorderWeeks,
      infeasible: a.infeasible + s.stats.infeasibleWeeks,
      perishableWeeks: a.perishableWeeks + (s.perishable ? s.weeklyTriage.length : 0),
      borderline: a.borderline + s.stats.borderlineWeeks,
      hdUplift: a.hdUplift + s.stats.hdWithUplift,
      hdBelow: a.hdBelow + s.stats.hdBelowNormal,
    }),
    { reorder: 0, infeasible: 0, perishableWeeks: 0, borderline: 0, hdUplift: 0, hdBelow: 0 },
  );
  push("### Review load and rule behaviour (D8, C-029)", "");
  push(`- Queue cards per Monday: average **${n(m.load.avgQueue, 1)}**, most **${n(m.load.maxQueue)}**; auto-approved per Monday: **${n(m.load.avgAuto, 1)}** (of which spot-checks ${n(m.load.avgSpotChecks, 1)}).`);
  push(`- Reorder recommendations: ${n(st.reorder)}; perishable infeasible: ${n(st.infeasible)}${st.perishableWeeks ? ` (${pct(st.infeasible / st.perishableWeeks)} of perishable SKU-weeks)` : ""}; borderline: ${n(st.borderline)}.`);
  push(`- High demand stacked on a festival uplift: ${n(st.hdUplift)} SKU-weeks.`);
  push(`- High-demand quantity below the normal quantity (C-029): ${n(st.hdBelow)} SKU-weeks.`, "");

  push("## 4. Method QA (data:validate-data)", "");
  push(`- Units conserved in every simulated arm (opening + receipts = sold + written off + closing; a guard against simulator bugs): **${r.qa.conservation ? "yes" : "NO"}**`);
  push(`- Weeks with no sales rows at all in the export: **${r.qa.missingWeeks.length ? r.qa.missingWeeks.join(", ") : "none"}**; W53: ${r.qa.w53}`);
  push(`- SKUs whose stock was partly rebuilt (D20; ignores write-offs and shrinkage, so past stock can be understated): ${r.qa.stockRebuilt}`);
  const u = m.qa.unexplainedChange;
  push(
    u === null
      ? "- Net unexplained change: **not checkable** (no weekly stock history), so missing receipts can't be detected."
      : `- Net unexplained change in the real history: **${pct(u)} of receipts** (+ = loss: shrinkage and write-offs SAP doesn't export; − = stock from nowhere, i.e. missing receipts; limit −${MAX_UNEXPLAINED_GAIN * 100}%).`,
  );
  const tracked = m.skus.filter((s) => s.qa && s.qa.trackedWeeks > 0);
  if (tracked.length) {
    const avgGap = tracked.reduce((a, s) => a + s.qa!.trackingMeanAbs!, 0) / tracked.length;
    push(`- Actual arm vs real SAP stock: mean absolute gap **${n(avgGap, 1)} units** per SKU-week over ${tracked.length} SKUs${m.qa.drift !== null ? `; non-perishable drift **${Math.round(m.qa.drift * 100)}%** of real on-hand (limit ${MAX_TRACKING_GAP * 100}%, C-032)` : ""}.`);
  } else push("- Actual arm vs real SAP stock: **not checkable**. There is no weekly stock history, so stock was rebuilt (D20) and write-offs come from the simulator's ageing only (C-014 option C).");
  push(`- ordered_units supplied: **${m.qa.orderedSupplied ? "yes" : "no"}**${m.qa.orderedSupplied ? "" : " (manual planning's lost sales are probably under-counted; see §5)"}.`);
  push("");

  push("## 5. Limits", "");
  push("- Rules-arm orders arrive after the lead time in full; a one-week-late variant is run, and a PASS must survive it.");
  push("- Without ordered_units, demand in empty-shelf weeks is imputed and mid-week stockouts are invisible: in the stress test the actual arm saw about half the true lost-sales weeks. This bias works against the rules.");
  push("- Backlog shipped the following week can be counted twice when demand is imputed.");
  push("- The literal festival reading uplifts festival-month history; a second reading (uplift when the run month is a festival month) is not modelled.");
  push("- Demand doesn't react to an arm's own stockouts (lost customers aren't modelled).");
  push("- Every recommendation is taken as approved at the engine's quantity; the Tuesday deadline isn't modelled.");
  push("- The real age of opening stock isn't known; it is assumed to have arrived evenly over the previous weeks, the same for both arms.");
  push("- The rules count stock that is about to expire as cover (D5 position has no age). Perishable losses from that are real behaviour of the rules, not of the simulator.");
  push("- Perishables without a shelf life or MOQ in the master are left out of the comparison (C-033); they are still simulated and listed in §2.");
  return lines.join("\n") + "\n";
}
