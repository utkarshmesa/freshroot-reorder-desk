import { readFileSync } from "node:fs";
import path from "node:path";
import { addWeeks } from "@/lib/isoweek";
import { DEFAULT_RULES, type RuleParams } from "@/lib/rules/defaults";
import { prepareUpload } from "@/lib/upload/validate";
import type { EngineInput, SkuInput } from "@/lib/engine/types";
import { context, fileFromBytes } from "./upload";

const ROOT = process.cwd();

/** Case data → engine input, through the same upload parser/mapper the app uses (C-011). */
export function caseInput(over: Partial<EngineInput> = {}): EngineInput {
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) =>
    fileFromBytes(`${f}.csv`, new Uint8Array(readFileSync(path.join(ROOT, `data/case/${f}.csv`)))),
  );
  const { staging, report } = prepareUpload(
    files,
    context({ caseDataMode: true, knownSkuIds: new Set(), knownDistributorIds: new Set(), knownSupplierIds: new Set(), latestCommittedWeek: null, lastAsOf: null }),
  );
  if (report.errors) throw new Error(JSON.stringify(report.issues));
  const rows = (k: string) => staging.filter((s) => s.kind === k).map((s) => s.row);
  return {
    runWeek: "2026-W43",
    rules: DEFAULT_RULES,
    caseDataMode: true,
    skus: rows("sku").map((r) => ({
      id: String(r.id),
      name: String(r.name),
      category: (r.category as string) ?? null,
      status: "active",
      firstSaleWeek: null,
      launchEstimateWk: null,
      stdQty: Number(r.std_qty),
      moq: null,
      packSize: null,
      leadTimeWks: null,
      shelfLifeWks: null,
      perishable: Boolean(r.perishable),
      unitCostInr: null,
      supplierId: String(r.supplier_id),
    })),
    distributors: [{ id: "ALL", status: "active", startWeek: null, endWeek: null }],
    events: rows("festival").map((r) => ({
      type: "festival" as const,
      startDate: String(r.start_date),
      endDate: String(r.end_date),
      skuIds: [],
      distributorIds: [],
      upliftPct: Number(r.uplift_pct),
      preloadWks: Number(r.preload_wks),
    })),
    sales: rows("sales").map((r) => ({ skuId: String(r.sku_id), distributorId: String(r.distributor_id), week: String(r.iso_week), shipped: Number(r.shipped_units), returns: Number(r.returns_units) })),
    onHand: Object.fromEntries(rows("stock").map((r) => [String(r.sku_id), Number(r.on_hand_units)])),
    stockHistory: {},
    poLines: [],
    receipts: [],
    holdout: [],
    blocked: {},
    spotCheckSeed: 42,
    ...over,
  };
}

/** A minimal synthetic input: one SKU, one distributor, flat weekly sales. */
export function oneSku(sku: Partial<SkuInput>, weekly: number[], opts: Partial<EngineInput> & { rules?: RuleParams } = {}): EngineInput {
  const runWeek = opts.runWeek ?? "2026-W30";
  const weeks = weekly.map((_, i) => {
    // weekly[last] is the week before the run
    const n = weekly.length - i;
    return addWeeks(runWeek, -n);
  });
  return {
    runWeek,
    rules: DEFAULT_RULES,
    caseDataMode: false,
    skus: [
      {
        id: "S1",
        name: "Test SKU",
        category: null,
        status: "active",
        firstSaleWeek: null,
        launchEstimateWk: null,
        stdQty: 100,
        moq: null,
        packSize: null,
        leadTimeWks: null,
        shelfLifeWks: null,
        perishable: false,
        unitCostInr: null,
        supplierId: "SUP",
        ...sku,
      },
    ],
    distributors: [{ id: "D1", status: "active", startWeek: null, endWeek: null }],
    events: [],
    sales: weekly.map((u, i) => ({ skuId: "S1", distributorId: "D1", week: weeks[i]!, shipped: u, returns: 0 })),
    onHand: { S1: 0 },
    stockHistory: {},
    poLines: [],
    receipts: [],
    holdout: [],
    blocked: {},
    spotCheckSeed: 1,
    ...opts,
  };
}
