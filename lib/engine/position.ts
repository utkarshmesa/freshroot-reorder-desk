// Stock position (D5, D15): SAP on-hand at Sunday 23:59 + open PO qty (not draft, not cancelled,
// ordered − received, never negative) + Zoho receipts dated Monday of the run week or later.
// Drafts are excluded by status only: an issued system (FR-) PO is real stock on order.
import { mondayOf, type IsoWeek } from "@/lib/isoweek";
import type { PoLine, Receipt } from "./types";

export type PositionLine = { poNumber: string; openQty: number; expectedDate: string | null; overdue: boolean };
export type Position = { onHand: number; openPoQty: number; receiptsAfterSnapshot: number; position: number; lines: PositionLine[] };

// "closed" is excluded: a PO closed by hand with quantity left over will not deliver it.
const COUNTS = new Set<PoLine["status"]>(["open", "partially_received", "received", "billed"]);

export function position(skuId: string, onHand: number, poLines: PoLine[], receipts: Receipt[], runWeek: IsoWeek): Position {
  const monday = mondayOf(runWeek);
  const lines: PositionLine[] = [];
  let openPoQty = 0;
  for (const l of poLines) {
    if (l.skuId !== skuId || !COUNTS.has(l.status)) continue;
    const open = Math.max(0, l.ordered - l.received);
    if (open === 0) continue;
    openPoQty += open;
    // C-026: open quantity past its expected delivery date is flagged; P is unchanged.
    lines.push({ poNumber: l.poNumber, openQty: open, expectedDate: l.expectedDate, overdue: l.expectedDate !== null && l.expectedDate < monday });
  }
  const receiptsAfterSnapshot = receipts.filter((r) => r.skuId === skuId && r.date >= monday).reduce((a, r) => a + r.qty, 0);
  return { onHand, openPoQty, receiptsAfterSnapshot, position: onHand + openPoQty + receiptsAfterSnapshot, lines };
}
