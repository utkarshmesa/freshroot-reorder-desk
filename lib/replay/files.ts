// Replay-only export files (REPLAY_SPEC §1): receipts history and weekly stock history. Pure.
// Several rows for one SKU-week (one per goods receipt, or per storage location) are ADDED, never
// overwritten (review M4, finding 1). A week that isn't a real ISO week stops the run.
import { isValidWeek, type IsoWeek } from "@/lib/isoweek";
import type { ParsedTable } from "@/lib/upload/types";
import { parseUnits } from "@/lib/upload/values";

export type ReplayFiles = {
  receipts: Map<string, Partial<Record<IsoWeek, number>>>;
  stockHistory: Map<string, Partial<Record<IsoWeek, number>>>;
  receiptsFile: boolean;
  stockFile: boolean;
  errors: string[];
};

const has = (t: ParsedTable, cols: string[]) => cols.every((c) => t.headers.includes(c));

export function readReplayFiles(tables: ParsedTable[]): ReplayFiles {
  const out: ReplayFiles = { receipts: new Map(), stockHistory: new Map(), receiptsFile: false, stockFile: false, errors: [] };
  const add = (m: ReplayFiles["receipts"], t: ParsedTable, unitsCol: string) => {
    t.rows.forEach((r, i) => {
      const week = (r.iso_week ?? "").trim();
      const sku = (r.sku_id ?? "").trim();
      const units = parseUnits(r[unitsCol] ?? "");
      if (!isValidWeek(week)) return out.errors.push(`${t.name} row ${i + 1}: "${week}" is not a valid ISO week`);
      if (!sku) return out.errors.push(`${t.name} row ${i + 1}: sku_id is empty`);
      if (!units.ok) return out.errors.push(`${t.name} row ${i + 1}: ${units.message}`);
      const bySku = m.get(sku) ?? m.set(sku, {}).get(sku)!;
      bySku[week] = (bySku[week] ?? 0) + units.value;
    });
  };
  for (const t of tables) {
    if (has(t, ["iso_week", "sku_id", "received_units"])) {
      out.receiptsFile = true;
      add(out.receipts, t, "received_units");
    } else if (has(t, ["iso_week", "sku_id", "on_hand_units"])) {
      out.stockFile = true;
      add(out.stockHistory, t, "on_hand_units");
    }
  }
  return out;
}
