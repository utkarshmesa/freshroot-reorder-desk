import "server-only";
// Loads everything the pure engine needs for one run from the database (service role).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngineInput, EventInput, PoLine, Receipt } from "@/lib/engine/types";
import { addWeeks, prevWeek, sundayCloseIST, weekOfDate, type IsoWeek } from "@/lib/isoweek";
import type { RuleParams } from "@/lib/rules/defaults";

export type RunRow = {
  id: string;
  iso_week: IsoWeek;
  rule_version_id: number;
  mode: "shadow" | "live";
  spot_check_seed: number;
  status: string;
};

const SKU_BATCH = 25;

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

/** The IST calendar date of a timestamp. */
const istDate = (ts: string) => new Date(Date.parse(ts) + 330 * 60_000).toISOString().slice(0, 10);

export async function loadEngineInput(
  db: SupabaseClient,
  run: RunRow,
  opts: { caseDataMode: boolean; poLines?: PoLine[]; receipts?: Receipt[]; blocked?: Record<string, string> },
): Promise<EngineInput> {
  const rules = (await must(db.from("rule_version").select("params").eq("id", run.rule_version_id).single(), "rules")) as { params: RuleParams };
  const lastWeek = prevWeek(run.iso_week);
  const fromWeek = addWeeks(run.iso_week, -rules.params.lookbackWks);
  const snapshot = sundayCloseIST(lastWeek);

  const [skus, dists, events, holdout, stock] = await Promise.all([
    must(db.from("sku").select("*").order("id"), "skus"),
    must(db.from("distributor").select("id, status, start_week, end_week"), "distributors"),
    must(db.from("event").select("type, start_date, end_date, sku_ids, distributor_ids, uplift_pct, preload_wks"), "events"),
    must(db.from("holdout").select("sku_id"), "holdout"),
    must(db.from("stock_snapshot").select("sku_id, as_of_ts, on_hand_units").lte("as_of_ts", snapshot).gte("as_of_ts", sundayCloseIST(prevWeek(fromWeek))), "stock"),
  ]);

  const skuRows = skus as Array<Record<string, unknown>>;
  const onHand: Record<string, number> = {};
  const stockHistory: EngineInput["stockHistory"] = {};
  const snapMs = Date.parse(snapshot);
  for (const s of stock as Array<{ sku_id: string; as_of_ts: string; on_hand_units: number }>) {
    if (Date.parse(s.as_of_ts) === snapMs) onHand[s.sku_id] = s.on_hand_units;
    else (stockHistory[s.sku_id] ??= {})[weekOfDate(istDate(s.as_of_ts))] = s.on_hand_units;
  }

  const sales: EngineInput["sales"] = [];
  const ids = skuRows.map((s) => String(s.id));
  for (let i = 0; i < ids.length; i += SKU_BATCH) {
    const doc = (await must(db.rpc("engine_inputs", { p_sku_ids: ids.slice(i, i + SKU_BATCH), p_from_week: fromWeek, p_to_week: lastWeek }), "sales")) as Record<
      string,
      Array<[string, string, number, number]>
    >;
    for (const [skuId, rows] of Object.entries(doc)) for (const [d, w, shipped, returns] of rows) sales.push({ skuId, distributorId: d, week: w, shipped, returns });
  }

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    runWeek: run.iso_week,
    rules: rules.params,
    caseDataMode: opts.caseDataMode,
    skus: skuRows.map((s) => ({
      id: String(s.id),
      name: String(s.name),
      category: (s.category as string | null) ?? null,
      status: s.status as "active" | "inactive",
      firstSaleWeek: (s.first_sale_week as string | null) ?? null,
      launchEstimateWk: num(s.launch_estimate_wk),
      stdQty: Number(s.std_qty),
      moq: num(s.moq),
      packSize: num(s.pack_size),
      leadTimeWks: num(s.lead_time_wks),
      shelfLifeWks: num(s.shelf_life_wks),
      perishable: Boolean(s.perishable),
      unitCostInr: num(s.unit_cost_inr),
      supplierId: (s.supplier_id as string | null) ?? null,
    })),
    distributors: (dists as Array<{ id: string; status: "active" | "inactive"; start_week: string | null; end_week: string | null }>).map((d) => ({
      id: d.id,
      status: d.status,
      startWeek: d.start_week,
      endWeek: d.end_week,
    })),
    events: (events as Array<Record<string, unknown>>).map(
      (e): EventInput => ({
        type: e.type as "festival" | "hold",
        startDate: String(e.start_date),
        endDate: String(e.end_date),
        skuIds: (e.sku_ids as string[]) ?? [],
        distributorIds: (e.distributor_ids as string[]) ?? [],
        upliftPct: num(e.uplift_pct),
        preloadWks: Number(e.preload_wks ?? 0),
      }),
    ),
    sales,
    onHand,
    stockHistory,
    poLines: opts.poLines ?? [],
    receipts: opts.receipts ?? [],
    holdout: (holdout as Array<{ sku_id: string }>).map((h) => h.sku_id),
    blocked: opts.blocked ?? {},
    spotCheckSeed: Number(run.spot_check_seed),
  };
}

