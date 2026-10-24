// Run: npx tsx scripts/replay/stress/run.ts [scenario|all]. Synthetic only; see docs/STRESS_TEST_REPLAY.md.
// Stress experiments for the replay method against a known ground truth.
import { replayAll, bootstrapSum, type ReplaySummary } from "@/lib/replay/replay";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { makeWorld, type WorldOpts } from "./world";

const fmt = (x: number) => Math.round(x).toLocaleString("en-IN");

function run(name: string, wo: WorldOpts) {
  const w = makeWorld(wo);
  const s = replayAll(w.data, { rules: DEFAULT_RULES, weeks: w.weeks, events: w.events, distributors: [], receiptsKnown: true });
  const tr = Object.values(w.truth).reduce((a, t) => ({ lostWeeks: a.lostWeeks + t.lostWeeks, lostUnits: a.lostUnits + t.lostUnits, writeOff: a.writeOff + t.writeOff, shrink: a.shrink + t.shrink }), { lostWeeks: 0, lostUnits: 0, writeOff: 0, shrink: 0 });
  // Proposed drift check: net unexplained stock change as a share of receipts (negative = stock from nowhere).
  let net = 0;
  let rec = 0;
  for (const d of w.data) {
    for (let i = 13; i < w.weeks.length; i++) {
      const prev = d.stockHistory[w.weeks[i - 1]!];
      const now = d.stockHistory[w.weeks[i]!];
      const rc = d.receipts[w.weeks[i]!] ?? 0;
      const sold = d.sales.filter((x) => x.week === w.weeks[i]).reduce((a, x) => a + x.shipped - x.returns, 0);
      if (prev !== undefined && now !== undefined) net += prev + rc - sold - now;
      rec += rc;
    }
  }
  const drift = s.skus.filter((x) => x.qa?.trackingRelative != null);
  const perDrift = (p: boolean) => {
    const xs = drift.filter((x) => x.perishable === p).map((x) => x.qa!.trackingRelative!);
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : 0;
  };
  // Clustered bootstrap by supplier vs by SKU, for weeks-with-lost-sales difference.
  const bySku = s.skus.filter((x) => x.actual && x.rules && !x.noReceipts).map((x) => ({ sup: w.supplierOf[x.skuId]!, d: x.rules!.lostSalesWeeks - x.actual!.lostSalesWeeks }));
  const ciSku = bootstrapSum(bySku.map((x) => x.d));
  const sups = [...new Set(bySku.map((x) => x.sup))];
  const ciSup = bootstrapSum(sups.map((sp) => bySku.filter((x) => x.sup === sp).reduce((a, x) => a + x.d, 0)));
  console.log(`\n### ${name}`);
  console.log(`truth (history):      lost-sales weeks ${fmt(tr.lostWeeks)}, lost units ${fmt(tr.lostUnits)}, write-off units ${fmt(tr.writeOff)}, shrink units ${fmt(tr.shrink)}`);
  console.log(`replay actual arm:    lost-sales weeks ${fmt(s.actual.lostSalesWeeks)}, lost units ${fmt(s.actual.lost)}, write-off units ${fmt(s.actual.writeOff)}`);
  console.log(`replay rules arm:     lost-sales weeks ${fmt(s.rules.lostSalesWeeks)}, lost units ${fmt(s.rules.lost)}, write-off units ${fmt(s.rules.writeOff)}, C-031 stockout weeks ${fmt(s.rules.stockoutWeeks)} (actual ${fmt(s.actual.stockoutWeeks)})`);
  console.log(`drift (cumulative, current check): non-perishable ${perDrift(false)}%, perishable ${perDrift(true)}%   |   net unexplained change: ${fmt(net)} units = ${((net / rec) * 100).toFixed(1)}% of receipts (+ = loss, − = stock from nowhere)`);
  console.log(`lost-weeks diff CI: by SKU [${fmt(ciSku.low)}, ${fmt(ciSku.high)}] vs by supplier [${fmt(ciSup.low)}, ${fmt(ciSup.high)}] (estimate ${fmt(ciSku.estimate)})`);
  const moq = replayAll(w.data, { rules: DEFAULT_RULES, weeks: w.weeks, events: w.events, distributors: [], receiptsKnown: true, infeasible: "moq" });
  const left = s.skus.filter((x) => x.excluded).reduce((m, x) => ({ ...m, [x.excluded!]: (m[x.excluded!] ?? 0) + 1 }), {} as Record<string, number>);
  console.log(`compared ${s.compared}/${s.skus.length}; left out ${JSON.stringify(left)}; unexplained change ${s.qa.unexplainedChange === null ? "n/a" : (s.qa.unexplainedChange * 100).toFixed(1) + "%"}`);
  console.log(`verdict (skip): ${s.verdict.result} — ${s.verdict.reasons[0]?.slice(0, 200)}`);
  console.log(`verdict (moq):  ${moq.verdict.result} — ${moq.verdict.reasons[0]?.slice(0, 200)}`);
  return s;
}

const base: WorldOpts = { skus: 60, seed: 11, shrinkPerYear: 0, dropReceipts: 0, shelfLifeInMaster: true, trueShelfLife: 10, supplierShock: 0.3 };
const which = process.argv[2] ?? "all";
const S: Record<string, WorldOpts> = {
  S0_clean: base,
  S1_shrink2pct: { ...base, shrinkPerYear: 0.02 },
  S2_shrink6pct: { ...base, shrinkPerYear: 0.06 },
  S3_missing10pctReceipts: { ...base, dropReceipts: 0.1 },
  S4_shelfLifeBlank_true12: { ...base, shelfLifeInMaster: false, trueShelfLife: 12 },
  S5_shelfLifeBlank_true6: { ...base, shelfLifeInMaster: false, trueShelfLife: 6 },
  S6_leanRaghav: { ...base, raghavCycleWks: 1, raghavCoverWks: 4 },
};
for (const [k, v] of Object.entries(S)) if (which === "all" || which === k) run(k, v);
export type { ReplaySummary };
