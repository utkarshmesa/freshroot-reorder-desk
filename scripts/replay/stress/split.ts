import { replayAll } from "@/lib/replay/replay";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { makeWorld } from "./world";
const w = makeWorld({ skus: 60, seed: 11, supplierShock: 0.3, trueShelfLife: 10 });
const policy = (process.argv[2] ?? "skip") as "skip" | "moq";
const s = replayAll(w.data, { rules: DEFAULT_RULES, weeks: w.weeks, events: w.events, distributors: [], receiptsKnown: true, infeasible: policy });
const inf = s.skus.filter((x) => x.perishable).reduce((a, x) => a + x.stats.infeasibleWeeks, 0);
console.log("policy", policy, "perishable infeasible SKU-weeks", inf);
for (const p of [false, true]) {
  const xs = s.skus.filter((x) => x.perishable === p && x.actual && x.rules);
  const t = xs.reduce((a, x) => { const tr = w.truth[x.skuId]!; return { n: a.n + 1, tl: a.tl + tr.lostWeeks, al: a.al + x.actual!.lostSalesWeeks, rl: a.rl + x.rules!.lostSalesWeeks, tw: a.tw + tr.writeOff, aw: a.aw + x.actual!.writeOff, rw: a.rw + x.rules!.writeOff, ao: a.ao + x.actual!.avgOnHand, ro: a.ro + x.rules!.avgOnHand, imp: a.imp + x.stats.imputedWeeks }; }, { n: 0, tl: 0, al: 0, rl: 0, tw: 0, aw: 0, rw: 0, ao: 0, ro: 0, imp: 0 });
  console.log(p ? "PERISHABLE" : "NON-PERISHABLE", JSON.stringify(t));
}
// one non-perishable SKU with rules losses: show weekly triage/actions around a loss
const bad = s.skus.filter((x) => !x.perishable && x.rules && x.rules.lostSalesWeeks > 0).sort((a, b) => b.rules!.lostSalesWeeks - a.rules!.lostSalesWeeks)[0];
if (bad) console.log("worst non-perishable", bad.skuId, "rules lost weeks", bad.rules!.lostSalesWeeks, "orders", bad.rules!.orders, "reorderWeeks", bad.stats.reorderWeeks, "std", w.data.find((d) => d.sku.id === bad.skuId)!.sku.stdQty);
