// In-memory Zoho Inventory for tests: the endpoints lib/zoho uses, token checks, pagination, and
// scripted failures. It records every request so tests can assert "no writes" (ST-04) and call counts.
import type { Fetch } from "@/lib/zoho/http";
import type { ZohoItem, ZohoPo, ZohoReceive, ZohoVendor } from "@/lib/zoho/map";

export const ACCOUNTS = "https://accounts.zoho.in";
export const API_DOMAIN = "https://www.zohoapis.in";
export const API = `${API_DOMAIN}/inventory/v1`;
export const ORG = "60000000001";

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };

export class FakeZoho {
  pos = new Map<string, ZohoPo>();
  receives = new Map<string, ZohoReceive>();
  items = new Map<string, ZohoItem>();
  vendors = new Map<string, ZohoVendor>();
  validToken = "tok-1";
  refreshTokenValid = true;
  tokensMinted = 0;
  requests: Array<{ method: string; url: string; body?: string }> = [];
  /** When true, list endpoints ignore date filters (to test our own date filtering). */
  ignoreDateFilter = false;
  /** Responses to return for the next API calls, in order, before normal handling resumes. */
  script: Scripted[] = [];
  /** Status a created PO gets (Zoho creates drafts; anything else is the ZO-14 case). */
  createStatus = "draft";
  /** Create the PO, then answer 500: the "response lost after POST" case (ZO-04). */
  loseNextCreateResponse = false;
  /** Hide every PO created from now on from search and vendor lists (until cleared). */
  hideCreated = false;
  /** PO ids the reference search and vendor list don't show yet (Zoho lagging behind a create). */
  hiddenFromSearch = new Set<string>();
  private nextId = 1;

  addPo(po: Partial<ZohoPo> & { purchaseorder_id: string; status: string; line_items: ZohoPo["line_items"] }) {
    this.pos.set(po.purchaseorder_id, { purchaseorder_number: `PO-${po.purchaseorder_id}`, ...po } as ZohoPo);
  }
  addReceive(r: ZohoReceive) {
    this.receives.set(r.receive_id, r);
  }

  fetch: Fetch = async (url, init) => {
    this.requests.push({ method: init.method, url, body: init.body });
    const u = new URL(url);
    if (u.origin === ACCOUNTS) return this.token(u, init.method, init.body);
    if (init.headers.Authorization !== `Zoho-oauthtoken ${this.validToken}`) return res(401, { code: 57, message: "You are not authorized to perform this operation" });
    const next = this.script.shift();
    if (next) return res(next.status, next.body ?? { code: 1, message: `scripted ${next.status}` }, next.headers);
    if (u.searchParams.get("organization_id") !== ORG) return res(400, { code: 6041, message: "organization_id is missing" });
    const path = u.pathname.replace("/inventory/v1", "");
    if (init.method === "POST" && path === "/purchaseorders") return this.create(init.body);
    if (init.method !== "GET") return res(405, { code: 9, message: "fake: only GET and POST /purchaseorders are implemented" });

    const page = Number(u.searchParams.get("page") ?? 1);
    const per = Number(u.searchParams.get("per_page") ?? 200);
    const paged = <T>(key: string, all: T[]) => res(200, { code: 0, message: "success", [key]: all.slice((page - 1) * per, page * per), page_context: { page, per_page: per, has_more_page: page * per < all.length } });

    if (path === "/purchaseorders") {
      const status = u.searchParams.get("status");
      const vendor = u.searchParams.get("vendor_id");
      const ref = u.searchParams.get("reference_number");
      return paged(
        "purchaseorders",
        [...this.pos.values()]
          .filter((p) => (!status || p.status === status) && (!vendor || p.vendor_id === vendor) && (!ref || p.reference_number === ref) && (!(ref || vendor) || !this.hiddenFromSearch.has(p.purchaseorder_id)))
          .map(withoutLines),
      );
    }
    let m = /^\/purchaseorders\/([^/]+)$/.exec(path);
    if (m) {
      const po = this.pos.get(decodeURIComponent(m[1]!));
      return po ? res(200, { code: 0, message: "success", purchaseorder: po }) : res(404, { code: 1002, message: "Purchase order does not exist." });
    }
    if (path === "/purchasereceives") {
      const from = this.ignoreDateFilter ? "0000" : (u.searchParams.get("date_start") ?? "0000");
      const to = this.ignoreDateFilter ? "9999" : (u.searchParams.get("date_end") ?? "9999");
      return paged("purchasereceives", [...this.receives.values()].filter((r) => r.date >= from && r.date <= to).map(withoutLines));
    }
    m = /^\/purchasereceives\/([^/]+)$/.exec(path);
    if (m) {
      const r = this.receives.get(decodeURIComponent(m[1]!));
      return r ? res(200, { code: 0, message: "success", purchasereceive: r }) : res(404, { code: 1002, message: "not found" });
    }
    if (path === "/items") return paged("items", [...this.items.values()]);
    if (path === "/contacts") return paged("contacts", u.searchParams.get("contact_type") === "vendor" ? [...this.vendors.values()] : []);
    return res(404, { code: 5, message: `fake: no route ${path}` });
  };

  private create(body?: string) {
    const b = JSON.parse(body ?? "{}") as { vendor_id?: string; reference_number?: string; date?: string; line_items?: Array<{ item_id: string; quantity: number }> } & Record<string, unknown>;
    if ("status" in b) return res(400, { code: 9, message: "fake: our payload must never carry a status" });
    if (!b.vendor_id || !b.line_items?.length) return res(400, { code: 4, message: "vendor_id and line_items are required" });
    const id = `new-${this.nextId++}`;
    const po: ZohoPo = { purchaseorder_id: id, purchaseorder_number: `PO-${id}`, status: this.createStatus, vendor_id: b.vendor_id, reference_number: b.reference_number, date: b.date, line_items: b.line_items.map((l) => ({ item_id: l.item_id, quantity: l.quantity, quantity_received: 0 })), last_modified_time: new Date().toISOString() };
    this.pos.set(id, po);
    if (this.hideCreated) this.hiddenFromSearch.add(id);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      return res(500, { code: 1, message: "fake: response lost" });
    }
    return res(201, { code: 0, message: "The purchase order has been created.", purchaseorder: po });
  }

  private token(u: URL, method: string, body?: string) {
    if (method !== "POST" || u.pathname !== "/oauth/v2/token") return res(400, { error: "invalid_request" });
    if ([...u.searchParams.keys()].length) return res(400, { error: "fake: credentials must be in the body, not the URL" });
    const form = new URLSearchParams(body ?? "");
    if (form.get("grant_type") !== "refresh_token") return res(400, { error: "unsupported_grant_type" });
    if (!this.refreshTokenValid) return res(200, { error: "invalid_code" });
    this.tokensMinted++;
    this.validToken = `tok-${this.tokensMinted + 1}`;
    return res(200, { access_token: this.validToken, expires_in: 3600, api_domain: API_DOMAIN, token_type: "Bearer" });
  }

  /** Requests other than GET to the API host (the token POST to the accounts host is excluded). */
  writes() {
    return this.requests.filter((r) => r.method !== "GET" && new URL(r.url).origin !== ACCOUNTS);
  }
}

/** List endpoints return summaries without line items. */
function withoutLines<T extends { line_items: unknown }>(o: T): Omit<T, "line_items"> {
  const copy: Partial<T> = { ...o };
  delete copy.line_items;
  return copy as Omit<T, "line_items">;
}

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = JSON.stringify(body); // serialised now: a sent response never changes afterwards
  return { status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => text };
}
