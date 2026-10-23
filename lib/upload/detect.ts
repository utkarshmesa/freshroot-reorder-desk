// File type is detected from headers, never from the file name (BUILD_PLAN §7).
import type { FileKind } from "./types";

type Shape = { required: string[]; optional: string[]; caseOnly: boolean };

export const SHAPES: Record<FileKind, Shape> = {
  sales_weekly: { required: ["iso_week", "sku_id", "distributor_id", "shipped_units", "returns_units"], optional: ["ordered_units"], caseOnly: false },
  stock_snapshot: { required: ["as_of_ts", "sku_id", "on_hand_units"], optional: [], caseOnly: false },
  sku_master: {
    required: ["id", "name", "std_qty", "perishable", "supplier_id"],
    optional: ["category", "status", "first_sale_week", "launch_estimate_wk", "moq", "pack_size", "uom", "lead_time_wks", "shelf_life_wks", "unit_cost_inr", "zoho_item_id"],
    caseOnly: false,
  },
  distributor_master: { required: ["id", "name"], optional: ["region", "status", "start_week", "end_week"], caseOnly: false },
  case_sku_master: {
    required: ["sku_id", "sku_name", "category", "perishability", "standard_reorder_qty", "unit_of_measure", "distributor_id"],
    optional: [],
    caseOnly: true,
  },
  case_distributor_master: { required: ["distributor_id", "distributor_name", "region", "status"], optional: [], caseOnly: true },
  case_weekly_sales: { required: ["sku_id", "week", "units_sold"], optional: [], caseOnly: true },
  case_inventory: { required: ["sku_id", "location", "units_on_hand", "as_of_date"], optional: [], caseOnly: true },
  case_calendar: { required: ["year", "month", "year_month", "is_festival_month"], optional: [], caseOnly: true },
};

export function detectKind(headers: string[]): FileKind | null {
  const set = new Set(headers);
  for (const [kind, shape] of Object.entries(SHAPES) as Array<[FileKind, Shape]>) {
    const allowed = new Set([...shape.required, ...shape.optional]);
    if (shape.required.every((h) => set.has(h)) && headers.every((h) => allowed.has(h))) return kind;
  }
  return null;
}
