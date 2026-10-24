// Read-only Zoho calls for a run (§8 step 1). Uses only GET. Endpoint and filter names are assumptions
// until the week-1 test-org check (ADR-0002) records real responses.
import { mondayOf, type IsoWeek } from "@/lib/isoweek";
import type { PoLine, Receipt } from "@/lib/engine/types";
import { ZohoApiError, ZohoDataError, type ZohoHttp } from "./http";
import { COUNTED_ZOHO_STATUSES, poStatus, toPoLines, toReceipts, type ZohoItem, type ZohoPo, type ZohoPoSummary, type ZohoReceive, type ZohoVendor } from "./map";

const PER_PAGE = 200;

type Page = { page_context?: { has_more_page?: boolean } };

async function listAll<T>(http: ZohoHttp, path: string, key: string, query: Record<string, string | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const res = await http.get<Record<string, unknown> & Page>(path, { ...query, page, per_page: PER_PAGE });
    out.push(...((res[key] as T[] | undefined) ?? []));
    if (!res.page_context?.has_more_page) return out;
  }
}

export type ZohoRead = {
  readAt: string;
  calls: number;
  poLines: PoLine[];
  receipts: Receipt[];
  items: Record<string, ZohoItem>;
  vendors: Record<string, ZohoVendor>;
  /** POs read in full, for draft read-back and the hold list. */
  poCount: number;
};

/** Everything the run needs from Zoho, mapped to our SKUs. */
export async function readForRun(http: ZohoHttp, args: { runWeek: IsoWeek; itemToSku: ReadonlyMap<string, string>; now: () => Date }): Promise<ZohoRead> {
  const { runWeek, itemToSku } = args;

  // Every PO, not only the statuses we expect (stress test F5): a status we don't know blocks the run instead of
  // being silently skipped, which would leave its open quantity out of the position. Details are fetched only
  // for statuses that can still have quantity on order.
  const counted = new Set(COUNTED_ZOHO_STATUSES.map((x) => poStatus(x)));
  const summaries = new Map<string, ZohoPoSummary>();
  for (const po of await listAll<ZohoPoSummary>(http, "/purchaseorders", "purchaseorders")) {
    const st = poStatus(po.status);
    if (st === null) throw new ZohoDataError(`Unknown Zoho PO status "${po.status}" on ${po.purchaseorder_number}: the position can't be trusted, so the run is blocked.`);
    if (counted.has(st)) summaries.set(po.purchaseorder_id, po);
  }
  const poLines: PoLine[] = [];
  for (const id of [...summaries.keys()].sort()) {
    const { purchaseorder } = await http.get<{ purchaseorder: ZohoPo }>(`/purchaseorders/${encodeURIComponent(id)}`);
    poLines.push(...toPoLines(purchaseorder, itemToSku));
  }

  const monday = mondayOf(runWeek);
  // Start date only: an end date in UTC could fall before Monday in IST (review M3, finding 7).
  const receiveList = await listAll<{ receive_id: string; date: string }>(http, "/purchasereceives", "purchasereceives", { date_start: monday });
  const receipts: Receipt[] = [];
  for (const r of receiveList.filter((x) => x.date.slice(0, 10) >= monday).sort((a, b) => a.receive_id.localeCompare(b.receive_id))) {
    const { purchasereceive } = await http.get<{ purchasereceive: ZohoReceive }>(`/purchasereceives/${encodeURIComponent(r.receive_id)}`);
    receipts.push(...toReceipts(purchasereceive, itemToSku).filter((x) => x.date >= monday));
  }

  const items = Object.fromEntries((await listAll<ZohoItem>(http, "/items", "items")).map((i) => [i.item_id, i]));
  const vendors = Object.fromEntries((await listAll<ZohoVendor>(http, "/contacts", "contacts", { contact_type: "vendor" })).map((v) => [v.contact_id, v]));

  return { readAt: args.now().toISOString(), calls: http.callCount, poLines, receipts, items, vendors, poCount: summaries.size };
}

/** Zoho's "does not exist" code (assumption until the scope check records it). Any other 404 fails closed. */
export const ZOHO_NOT_FOUND_CODE = 1002;

/** One system draft by its stored id (read-back by id, not reference: procurement may edit the reference). Null = deleted. */
export async function readPo(http: ZohoHttp, poId: string): Promise<ZohoPo | null> {
  try {
    const { purchaseorder } = await http.get<{ purchaseorder: ZohoPo }>(`/purchaseorders/${encodeURIComponent(poId)}`);
    return purchaseorder;
  } catch (e) {
    if (e instanceof ZohoApiError && e.status === 404 && e.code === ZOHO_NOT_FOUND_CODE) return null;
    throw e;
  }
}
