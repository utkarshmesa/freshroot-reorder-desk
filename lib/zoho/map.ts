// Pure mappers from Zoho Inventory JSON to engine types, plus the mapping check (§8 step 2) and the
// draft read-back comparison (§8 step 3, D11). Field names follow the Zoho Inventory v1 API; they are
// assumptions until the week-1 test-org check records real responses (ADR-0002).
import type { PoLine, Receipt } from "@/lib/engine/types";

export type ZohoPoSummary = { purchaseorder_id: string; purchaseorder_number: string; status: string; reference_number?: string; last_modified_time?: string };
export type ZohoPoLine = { line_item_id?: string; item_id: string; quantity: number; quantity_received?: number };
export type ZohoPo = ZohoPoSummary & { vendor_id?: string; delivery_date?: string; date?: string; line_items: ZohoPoLine[] };
export type ZohoReceive = { receive_id: string; date: string; purchaseorder_id: string; line_items: Array<{ item_id: string; quantity: number }> };
export type ZohoItem = { item_id: string; sku?: string; name?: string; unit?: string; status?: string };
export type ZohoVendor = { contact_id: string; contact_name?: string; status?: string };

const STATUS: Record<string, PoLine["status"]> = {
  draft: "draft",
  open: "open",
  issued: "open",
  partially_received: "partially_received",
  received: "received",
  billed: "billed",
  partially_billed: "billed",
  closed: "closed",
  cancelled: "cancelled",
  void: "cancelled",
};

/** Zoho status → engine status. Unknown statuses fail closed (treated as an error by the caller). */
export function poStatus(s: string): PoLine["status"] | null {
  return STATUS[s.toLowerCase().replace(/\s+/g, "_")] ?? null;
}

/** PO lines for our SKUs only. `itemToSku` maps Zoho item_id → our SKU id (from sku.zoho_item_id). */
export function toPoLines(po: ZohoPo, itemToSku: ReadonlyMap<string, string>): PoLine[] {
  const status = poStatus(po.status);
  if (!status) throw new Error(`Unknown Zoho purchase order status "${po.status}" on ${po.purchaseorder_number}`);
  return po.line_items
    .filter((l) => itemToSku.has(l.item_id))
    .map((l) => ({
      poId: po.purchaseorder_id,
      poNumber: po.purchaseorder_number,
      status,
      skuId: itemToSku.get(l.item_id)!,
      ordered: Number(l.quantity),
      received: Number(l.quantity_received ?? 0),
      expectedDate: po.delivery_date || null,
    }));
}

export function toReceipts(rc: ZohoReceive, itemToSku: ReadonlyMap<string, string>): Receipt[] {
  return rc.line_items
    .filter((l) => itemToSku.has(l.item_id))
    .map((l) => ({ poId: rc.purchaseorder_id, skuId: itemToSku.get(l.item_id)!, date: rc.date.slice(0, 10), qty: Number(l.quantity) }));
}

// ---------- mapping check (§8 step 2, A4) ----------

export type SkuMapping = { id: string; status: string; uom: string | null; zohoItemId: string | null; supplierId: string | null; zohoVendorId: string | null };

/** SKUs that can't be ordered, with the reason. Active SKUs only; inactive ones order nothing anyway. */
export function mappingCheck(skus: SkuMapping[], items: ReadonlyMap<string, ZohoItem>, vendors: ReadonlyMap<string, ZohoVendor>): Record<string, string> {
  const blocked: Record<string, string> = {};
  for (const s of skus) {
    if (s.status !== "active") continue;
    if (!s.zohoItemId) blocked[s.id] = "No Zoho item mapped (Settings › SKUs)";
    else if (!items.has(s.zohoItemId)) blocked[s.id] = `Zoho item ${s.zohoItemId} not found`;
    else if ((items.get(s.zohoItemId)!.status ?? "active") !== "active") blocked[s.id] = `Zoho item ${s.zohoItemId} is ${items.get(s.zohoItemId)!.status}`;
    else if (s.uom && items.get(s.zohoItemId)!.unit && s.uom.trim().toLowerCase() !== items.get(s.zohoItemId)!.unit!.trim().toLowerCase())
      blocked[s.id] = `Unit mismatch: SKU master says "${s.uom}", Zoho item says "${items.get(s.zohoItemId)!.unit}" (A4)`;
    else if (!s.supplierId) blocked[s.id] = "No supplier (Settings › SKUs)";
    else if (!s.zohoVendorId) blocked[s.id] = `Supplier ${s.supplierId} has no Zoho vendor mapped (Settings › Suppliers)`;
    else if (!vendors.has(s.zohoVendorId)) blocked[s.id] = `Zoho vendor ${s.zohoVendorId} not found`;
    else if ((vendors.get(s.zohoVendorId)!.status ?? "active") !== "active") blocked[s.id] = `Zoho vendor ${s.zohoVendorId} is ${vendors.get(s.zohoVendorId)!.status}`;
  }
  return blocked;
}

// ---------- draft read-back (§8 step 3, D11) ----------

export type RequestedLine = { sku_id: string; item_id: string; qty: number };
export type Readback =
  | { status: "deleted" }
  | { status: "created" | "issued" | "edited"; pending: boolean; lines: Array<{ item_id: string; qty: number }>; changed: boolean; zohoStatus: string };

/** Compares a system draft as Zoho has it now with what we asked for. `po` null = not found (deleted). */
export function readback(po: ZohoPo | null, requested: RequestedLine[]): Readback {
  if (!po) return { status: "deleted" };
  const st = poStatus(po.status);
  if (st === "cancelled") return { status: "deleted" };
  const lines = po.line_items.map((l) => ({ item_id: l.item_id, qty: Number(l.quantity) }));
  const key = (xs: Array<{ item_id: string; qty: number }>) =>
    xs
      .map((x) => `${x.item_id}:${x.qty}`)
      .sort()
      .join("|");
  const changed = key(lines) !== key(requested.map((r) => ({ item_id: r.item_id, qty: r.qty })));
  if (st === "draft") return { status: "created", pending: true, lines, changed, zohoStatus: po.status };
  return { status: changed ? "edited" : "issued", pending: false, lines, changed, zohoStatus: po.status };
}
