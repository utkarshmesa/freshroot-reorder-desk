// Ground-truth world for stress-testing the replay method (synthetic; never Freshroots data).
// It generates 3 years of what SAP would export from a known world, plus the true outcomes.
import { addWeeks, mondayOf, type IsoWeek } from "@/lib/isoweek";
import type { EventInput, SalesRow, SkuInput } from "@/lib/engine/types";
import type { SkuData } from "@/lib/replay/replay";

export type WorldOpts = {
  skus?: number;
  weeks?: number;
  seed?: number;
  shrinkPerYear?: number; // share of on-hand lost per year to shrinkage/damage (all SKUs)
  perishableShare?: number;
  trueShelfLife?: number; // weeks, perishables
  raghavCycleWks?: number; // he orders every N weeks
  raghavCoverWks?: number; // ...for this many weeks of forecast
  dropReceipts?: number; // share of receipt rows missing from the export
  shelfLifeInMaster?: boolean; // false = blank in the SKU master (D18 default then applies)
  suppliers?: number;
  supplierShock?: number; // demand correlation within a supplier
};

export type Truth = { lostUnits: number; lostWeeks: number; writeOff: number; shrink: number; zeroWeeks: number };
export type World = { data: SkuData[]; weeks: IsoWeek[]; events: EventInput[]; truth: Record<string, Truth>; supplierOf: Record<string, string> };

export function makeWorld(o: WorldOpts = {}): World {
  const N = o.skus ?? 60;
  const W = o.weeks ?? 156;
  let seed = o.seed ?? 11;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const weeks = Array.from({ length: W }, (_, i) => addWeeks("2023-W40", i));
  const fest = (w: IsoWeek) => {
    const m = Number(mondayOf(w).slice(5, 7));
    return m === 10 || m === 11 || m === 3;
  };
  const events: EventInput[] = [2023, 2024, 2025, 2026].flatMap((y) => [
    { type: "festival" as const, startDate: `${y}-03-01`, endDate: `${y}-03-31`, skuIds: [], distributorIds: [], upliftPct: 25, preloadWks: 3 },
    { type: "festival" as const, startDate: `${y}-10-01`, endDate: `${y}-11-30`, skuIds: [], distributorIds: [], upliftPct: 25, preloadWks: 3 },
  ]);
  const shrinkWk = (o.shrinkPerYear ?? 0) / 52;
  const S = o.suppliers ?? 12;
  const supShock = Array.from({ length: S }, () => weeks.map(() => 1 + (o.supplierShock ?? 0) * (r() - 0.5)));
  const data: SkuData[] = [];
  const truth: Record<string, Truth> = {};
  const supplierOf: Record<string, string> = {};

  for (let s = 0; s < N; s++) {
    const id = `W${String(s).padStart(3, "0")}`;
    const sup = s % S;
    supplierOf[id] = `SUP${sup}`;
    const perishable = r() < (o.perishableShare ?? 0.3);
    const base = 20 + Math.floor(r() * 180);
    const std = Math.max(10, Math.round(base * 2));
    const lead = 2;
    const shelf = perishable ? (o.trueShelfLife ?? 10) : null;
    const sku: SkuInput = {
      id, name: id, category: null, status: "active", firstSaleWeek: null, launchEstimateWk: null, stdQty: std, moq: null, packSize: null,
      leadTimeWks: lead, shelfLifeWks: perishable && (o.shelfLifeInMaster ?? true) ? shelf : null, perishable, unitCostInr: null, supplierId: `SUP${sup}`,
    };
    let lots: Array<{ q: number; a: number }> = [{ q: base * 6, a: 0 }];
    const pipe: Array<{ arrive: number; q: number }> = [];
    const sales: SalesRow[] = [];
    const receipts: Record<string, number> = {};
    const stock: Record<string, number> = {};
    const t: Truth = { lostUnits: 0, lostWeeks: 0, writeOff: 0, shrink: 0, zeroWeeks: 0 };
    const sold: number[] = [];
    for (let i = 0; i < W; i++) {
      // Raghav: every cycle, forecast from last 12 weeks of (censored) sales, +25% in festival months.
      if (i % (o.raghavCycleWks ?? 4) === 0) {
        const hist = sold.slice(-12);
        const f = (hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : base) * (fest(weeks[i]!) ? 1.25 : 1);
        const pos = lots.reduce((a, l) => a + l.q, 0) + pipe.reduce((a, p) => a + p.q, 0);
        const want = f * ((o.raghavCoverWks ?? 6) + lead) - pos;
        if (want > 0) pipe.push({ arrive: i + lead + 1, q: Math.ceil(want / std) * std }); // +1: monthly paperwork lag
      }
      const arriving = pipe.filter((p) => p.arrive === i).reduce((a, p) => a + p.q, 0);
      for (let k = pipe.length - 1; k >= 0; k--) if (pipe[k]!.arrive <= i) pipe.splice(k, 1); // delivered: no longer on order
      if (arriving) {
        lots.push({ q: arriving, a: 0 });
        if (r() >= (o.dropReceipts ?? 0)) receipts[weeks[i]!] = arriving;
      }
      const demand = Math.round(base * (fest(weeks[i]!) ? 1.3 : 1) * (0.8 + r() * 0.4) * supShock[sup]![i]!);
      let need = demand;
      for (const l of lots) {
        const take = Math.min(l.q, need);
        l.q -= take;
        need -= take;
      }
      const got = demand - need;
      sold.push(got);
      if (i >= 13 && need >= 1) {
        t.lostUnits += need;
        t.lostWeeks++;
      }
      lots = lots.filter((l) => l.q > 0);
      // shrinkage, proportional
      for (const l of lots) {
        const lost = l.q * shrinkWk;
        l.q -= lost;
        if (i >= 13) t.shrink += lost;
      }
      lots.forEach((l) => (l.a += 1));
      if (shelf !== null) {
        for (const l of lots) if (l.a >= shelf && i >= 13) t.writeOff += l.q;
        lots = lots.filter((l) => l.a < shelf);
      }
      const oh = Math.round(lots.reduce((a, l) => a + l.q, 0));
      if (i >= 13 && oh === 0) t.zeroWeeks++;
      stock[weeks[i]!] = oh;
      // sales split across 8 distributors
      let left = got;
      for (let d = 0; d < 8; d++) {
        const part = d === 7 ? left : Math.floor(got / 8);
        left -= part;
        if (part) sales.push({ skuId: id, distributorId: `D${d}`, week: weeks[i]!, shipped: part, returns: 0 });
      }
    }
    data.push({ sku, sales, receipts, stockHistory: stock });
    truth[id] = t;
  }
  return { data, weeks, events, truth, supplierOf };
}
