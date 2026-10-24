// C-039 Zoho failsafe (file mode): reads the open-PO and receipts files that stand in for the Zoho read in a
// week when Zoho can't be used. Pure. Statuses use Zoho's names (the file is a Zoho export, or kept by hand in the
// same shape); an unknown status, SKU or number is refused, never guessed (fail closed).
import type { PoLine, Receipt } from "@/lib/engine/types";
import { mondayOf, type IsoWeek } from "@/lib/isoweek";
import type { ParsedTable } from "@/lib/upload/types";
import { parseUnits } from "@/lib/upload/values";
import { poStatus } from "@/lib/zoho/map";

export const OPEN_PO_COLUMNS = ["po_number", "supplier_id", "sku_id", "po_date", "ordered_units", "received_units", "status"] as const;
export const RECEIPT_COLUMNS = ["po_number", "sku_id", "receipt_date", "received_units"] as const;
const COUNTED = new Set<PoLine["status"]>(["open", "partially_received", "billed"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PositionFiles = {
  poLines: PoLine[];
  receipts: Receipt[];
  errors: string[];
  warnings: string[];
  summary: { openLines: number; openUnits: number; pos: number };
};

export function readPositionFiles(a: { openPos: ParsedTable; receipts: ParsedTable | null; runWeek: IsoWeek; skus: ReadonlySet<string> }): PositionFiles {
  const out: PositionFiles = { poLines: [], receipts: [], errors: [], warnings: [], summary: { openLines: 0, openUnits: 0, pos: 0 } };
  const err = (file: string, row: number, msg: string) => out.errors.push(`${file} row ${row}: ${msg}`);
  const missing = (t: ParsedTable, cols: readonly string[]) => cols.filter((c) => !t.headers.includes(c));

  const m1 = missing(a.openPos, OPEN_PO_COLUMNS);
  if (m1.length) out.errors.push(`${a.openPos.name}: missing columns ${m1.join(", ")} (needed: ${OPEN_PO_COLUMNS.join(", ")})`);
  else {
    a.openPos.rows.forEach((r, i) => {
      const n = i + 2;
      const sku = (r.sku_id ?? "").trim();
      const status = poStatus((r.status ?? "").trim());
      const ordered = parseUnits(r.ordered_units ?? "");
      const received = parseUnits(r.received_units ?? "0");
      const placed = (r.po_date ?? "").trim();
      const expected = (r.expected_date ?? "").trim();
      if (!a.skus.has(sku)) return err(a.openPos.name, n, `unknown SKU "${sku}"`);
      if (!status) return err(a.openPos.name, n, `unknown status "${r.status}" (use Zoho's status names)`);
      if (!ordered.ok) return err(a.openPos.name, n, `ordered_units: ${ordered.message}`);
      if (!received.ok) return err(a.openPos.name, n, `received_units: ${received.message}`);
      if (received.value > ordered.value && COUNTED.has(status)) return err(a.openPos.name, n, "received more than ordered on an open line");
      if (!DATE.test(placed)) return err(a.openPos.name, n, `po_date "${placed}" must be YYYY-MM-DD`);
      if (expected && !DATE.test(expected)) return err(a.openPos.name, n, `expected_date "${expected}" must be YYYY-MM-DD`);
      if (status === "draft") return; // drafts never count as stock (CLAUDE.md)
      const po = (r.po_number ?? "").trim();
      out.poLines.push({ poId: po, poNumber: po, status, skuId: sku, ordered: ordered.value, received: received.value, expectedDate: expected || null, placedDate: placed, reference: (r.reference ?? "").trim() || null });
    });
  }

  if (a.receipts) {
    const m2 = missing(a.receipts, RECEIPT_COLUMNS);
    if (m2.length) out.errors.push(`${a.receipts.name}: missing columns ${m2.join(", ")} (needed: ${RECEIPT_COLUMNS.join(", ")})`);
    else {
      const monday = mondayOf(a.runWeek);
      let early = 0;
      a.receipts.rows.forEach((r, i) => {
        const n = i + 2;
        const sku = (r.sku_id ?? "").trim();
        const date = (r.receipt_date ?? "").trim();
        const qty = parseUnits(r.received_units ?? "");
        if (!a.skus.has(sku)) return err(a.receipts!.name, n, `unknown SKU "${sku}"`);
        if (!DATE.test(date)) return err(a.receipts!.name, n, `receipt_date "${date}" must be YYYY-MM-DD`);
        if (!qty.ok) return err(a.receipts!.name, n, `received_units: ${qty.message}`);
        if (date < monday) {
          early++;
          return; // already in Sunday's SAP stock (A2)
        }
        out.receipts.push({ poId: (r.po_number ?? "").trim(), skuId: sku, date, qty: qty.value });
      });
      if (early) out.warnings.push(`${early} receipt line(s) dated before ${monday} were ignored: Sunday's SAP stock already includes them.`);
    }
  }

  const open = out.poLines.filter((l) => COUNTED.has(l.status));
  out.summary = { openLines: open.length, openUnits: open.reduce((s, l) => s + Math.max(0, l.ordered - l.received), 0), pos: new Set(out.poLines.map((l) => l.poId)).size };
  return out;
}
