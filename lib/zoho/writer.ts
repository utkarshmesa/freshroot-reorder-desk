// The only code that writes to Zoho (ARCHITECTURE §5 write-guard layers 3–4). It can create a draft PO and
// nothing else: no update, issue or delete method exists, the payload type has no status field, and a writer
// can't be made unless the effective mode is live. Reads used around the create are here too.
import type { ZohoHttp } from "./http";
import type { ZohoPo, ZohoPoSummary } from "./map";

export type DraftPayload = {
  vendor_id: string;
  reference_number: string;
  date: string;
  line_items: Array<{ item_id: string; quantity: number }>;
};

export function draftPayload(a: { vendorId: string; reference: string; date: string; lines: Array<{ itemId: string; qty: number }> }): DraftPayload {
  return { vendor_id: a.vendorId, reference_number: a.reference, date: a.date, line_items: a.lines.map((l) => ({ item_id: l.itemId, quantity: l.qty })) };
}

export class ZohoDraftWriter {
  private constructor(private readonly http: ZohoHttp) {}

  /** Throws unless live: shadow mode never constructs a writer (ST-04). */
  static forMode(mode: "live" | "shadow", http: ZohoHttp): ZohoDraftWriter {
    if (mode !== "live") throw new Error("Zoho writes are only possible in live mode");
    return new ZohoDraftWriter(http);
  }

  async createDraft(p: DraftPayload): Promise<ZohoPo> {
    const { purchaseorder } = await this.http.post<{ purchaseorder: ZohoPo }>("/purchaseorders", p);
    return purchaseorder;
  }
}

/** A vendor's POs (summaries, all pages). Filter names are assumptions until the test-org check (ADR-0002). */
export async function vendorPos(http: ZohoHttp, vendorId: string): Promise<ZohoPoSummary[]> {
  const out: ZohoPoSummary[] = [];
  for (let page = 1; ; page++) {
    const res = await http.get<{ purchaseorders?: Array<ZohoPoSummary & { vendor_id?: string }>; page_context?: { has_more_page?: boolean } }>("/purchaseorders", { vendor_id: vendorId, page, per_page: 200 });
    out.push(...(res.purchaseorders ?? []).filter((p) => !p.vendor_id || p.vendor_id === vendorId));
    if (!res.page_context?.has_more_page) return out;
  }
}

/** The PO carrying this exact reference, if Zoho has one. */
export async function findByReference(http: ZohoHttp, reference: string): Promise<ZohoPoSummary | null> {
  const res = await http.get<{ purchaseorders?: ZohoPoSummary[] }>("/purchaseorders", { reference_number: reference });
  return (res.purchaseorders ?? []).find((p) => p.reference_number === reference) ?? null;
}
