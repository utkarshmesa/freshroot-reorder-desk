// Rules engine types (BUILD_PLAN §8 steps 4–6). Pure data: no clients, no dates from the clock.
import type { IsoDate, IsoWeek } from "@/lib/isoweek";
import type { RuleParams } from "@/lib/rules/defaults";

export type SkuInput = {
  id: string;
  name: string;
  category: string | null;
  status: "active" | "inactive";
  firstSaleWeek: IsoWeek | null;
  launchEstimateWk: number | null;
  stdQty: number;
  moq: number | null;
  packSize: number | null;
  leadTimeWks: number | null;
  shelfLifeWks: number | null;
  perishable: boolean;
  unitCostInr: number | null;
  supplierId: string | null;
};

export type DistributorInput = {
  id: string;
  status: "active" | "inactive";
  startWeek: IsoWeek | null;
  endWeek: IsoWeek | null;
};

export type EventInput = {
  type: "festival" | "hold";
  startDate: IsoDate;
  endDate: IsoDate;
  skuIds: string[]; // empty = all SKUs
  distributorIds: string[]; // empty = all distributors
  upliftPct: number | null;
  preloadWks: number;
};

export type SalesRow = { skuId: string; distributorId: string; week: IsoWeek; shipped: number; returns: number };

/** A purchase-order line as read from Zoho, normalised (lib/zoho maps to this in milestone 3). */
export type PoLine = {
  poId: string;
  poNumber: string;
  status: "draft" | "open" | "partially_received" | "received" | "billed" | "closed" | "cancelled";
  skuId: string;
  ordered: number;
  received: number;
  expectedDate: IsoDate | null;
};

export type Receipt = { poId: string; skuId: string; date: IsoDate; qty: number };

export type EngineInput = {
  runWeek: IsoWeek;
  rules: RuleParams;
  caseDataMode: boolean;
  skus: SkuInput[];
  distributors: DistributorInput[];
  events: EventInput[];
  sales: SalesRow[];
  /** SAP on-hand at the Sunday 23:59 snapshot before the run week (D15). Missing SKU = no stock row. */
  onHand: Record<string, number>;
  /** On-hand at earlier Sunday snapshots, by week, for the zero-stock exclusion (C-007). */
  stockHistory: Record<string, Partial<Record<IsoWeek, number>>>;
  poLines: PoLine[];
  receipts: Receipt[];
  holdout: string[];
  /** SKUs blocked before the engine runs (e.g. no Zoho item/vendor mapping), with the reason. */
  blocked: Record<string, string>;
  spotCheckSeed: number;
  /**
   * Festival reading. Production uses "any" (C-004, pinned by the W43 reference). "share" and "none" are for the
   * replay only (D6): "none" is used with Raghav's literal reading, where the uplift is applied to history beforehand.
   */
  festivalReading?: "any" | "share" | "none";
};

export type Action = "reorder" | "pause" | "none" | "blocked";
export type Triage = "auto" | "queue" | "none" | "info_no_open_po";

export type Flag =
  | "high_demand"
  | "perishable"
  | "new_sku"
  | "hold"
  | "infeasible"
  | "borderline"
  | "conflict"
  | "capped_at_perishable_max"
  | "pack_mismatch"
  | "short_history"
  | "over_auto_limit"
  | "overdue_po"
  | "inactive"
  | "no_demand"
  | "no_launch_estimate"
  | "no_stock"
  | "unmapped";

export type Assumed = "lead_time" | "moq" | "shelf_life" | "unit_cost";

export type TopDistributor = { distributorId: string; deltaUnits: number; pct: number };

export type Recommendation = {
  skuId: string;
  name: string;
  supplierId: string | null;
  action: Action;
  qty: number;
  triage: Triage;
  /** D9: an auto-approved item also shown to Raghav as a spot-check. Triage stays "auto" (the W43 reference). */
  spotCheck: boolean;
  stdQty: number;
  packSize: number | null;
  flags: Flag[];
  assumed: Assumed[];
  holdout: boolean;
  a12: number;
  a4: number;
  /** Trend averages for the high-demand check (D2/D6: raw sales, newcomers' weeks 5–12 left out). */
  trendA12: number;
  trendA4: number;
  festivalFactor: number;
  forwardDemand: number;
  onHand: number | null;
  openPoQty: number;
  receiptsAfterSnapshot: number;
  position: number;
  cover: number | null;
  coverAfter: number | null;
  minEff: number;
  max: number;
  leadTimeWks: number;
  moq: number;
  cleanWeeks: number;
  daysToStockout: number | null;
  orderWeeks: IsoWeek[];
  openPoLines: Array<{ poNumber: string; openQty: number; expectedDate: IsoDate | null; overdue: boolean }>;
  /** Infeasible perishable: both choices, from engine numbers (C-023i). */
  infeasibleOptions: { orderMoq: { qty: number; coverAfter: number }; skip: { daysToStockout: number | null } } | null;
  topDistributors: TopDistributor[] | null;
  blockedReason: string | null;
};

export type EngineOutput = { runWeek: IsoWeek; recommendations: Recommendation[]; notes: string[]; missingFestivalYears: number[] };
