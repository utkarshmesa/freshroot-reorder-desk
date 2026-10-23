// Zoho read path against the in-memory Zoho (TEST_PLAN §3.3: ZO-03, ZO-05…ZO-12, ZO-15).
import { describe, expect, it } from "vitest";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";
import { ZohoApiError, ZohoAuthError, ZohoBudgetError, ZohoHttp } from "./http";
import { mappingCheck, poStatus, readback, toPoLines, type ZohoPo } from "./map";
import { readForRun, readPo } from "./reader";
import { memoryTokenSource } from "./token";

const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };

function setup(over: { budget?: number; perMinute?: number } = {}) {
  const z = new FakeZoho();
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const http = new ZohoHttp({
    apiBase: API,
    organizationId: ORG,
    fetch: z.fetch,
    token: memoryTokenSource(z.fetch, CFG),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...over,
  });
  return { z, http, sleeps };
}

const itemToSku = new Map([
  ["it-1", "SKU001"],
  ["it-2", "SKU002"],
]);

describe("auth (ZO-08, ZO-12)", () => {
  it("gets a token, retries once on 401 with a refreshed token, then succeeds", async () => {
    const { z, http } = setup();
    z.items.set("it-1", { item_id: "it-1", unit: "Units", status: "active" });
    await http.get("/items");
    const minted = z.tokensMinted;
    z.validToken = "expired-early"; // the cached access token stops working
    await http.get("/items"); // 401 → one refresh → retried with the new token → success
    expect(z.tokensMinted).toBe(minted + 1);
  });

  it("a 401 even after refreshing fails closed", async () => {
    const { z, http } = setup();
    await http.get("/items");
    z.script.push({ status: 401 }, { status: 401 });
    await expect(http.get("/items")).rejects.toThrow(ZohoAuthError);
  });

  it("a revoked refresh token fails closed with a clear message", async () => {
    const { z, http } = setup();
    z.refreshTokenValid = false;
    await expect(http.get("/items")).rejects.toThrow(/refresh token may be revoked/);
  });

  it("only ever uses grant_type=refresh_token on the accounts host (never mints refresh tokens)", async () => {
    const { z, http } = setup();
    await http.get("/items");
    const acct = z.requests.filter((r) => new URL(r.url).origin === ACCOUNTS);
    expect(acct).toHaveLength(1);
    expect(new URL(acct[0]!.url).searchParams.get("grant_type")).toBe("refresh_token");
    expect(z.writes()).toEqual([]);
  });
});

describe("retries, rate limit and budget (ZO-09, ZO-10)", () => {
  it("ZO-09 honours Retry-After on 429", async () => {
    const { z, http, sleeps } = setup();
    z.script.push({ status: 429, headers: { "Retry-After": "7" } });
    await http.get("/items");
    expect(sleeps).toEqual([7000]);
  });

  it("backs off 1, 2, 4, 8 s on 5xx and gives up after 5 tries", async () => {
    const { z, http, sleeps } = setup();
    for (let i = 0; i < 5; i++) z.script.push({ status: 503 });
    await expect(http.get("/items")).rejects.toThrow(ZohoApiError);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it("keeps under the per-minute limit", async () => {
    const { http, sleeps } = setup({ perMinute: 2 });
    await http.get("/items");
    await http.get("/items");
    await http.get("/items");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
  });

  it("ZO-10 stops at the per-run budget (fail closed)", async () => {
    const { http } = setup({ budget: 3 });
    for (let i = 0; i < 3; i++) await http.get("/items");
    await expect(http.get("/items")).rejects.toThrow(ZohoBudgetError);
    expect(http.callCount).toBe(3);
  });

  it("a Zoho error body (non-zero code) is an error even on HTTP 200", async () => {
    const { z, http } = setup();
    z.script.push({ status: 200, body: { code: 1001, message: "Invalid value" } });
    await expect(http.get("/items")).rejects.toThrow(/Invalid value/);
  });
});

describe("reading a run (ZO-01…03, ZO-11, ZO-15)", () => {
  it("ZO-11 pages through long lists", async () => {
    const { z, http } = setup();
    for (let i = 0; i < 450; i++) z.items.set(`x-${i}`, { item_id: `x-${i}`, status: "active" });
    const r = await readForRun(http, { runWeek: "2026-W43", today: "2026-10-19", itemToSku, now: () => new Date("2026-10-19T03:00:00Z") });
    expect(Object.keys(r.items)).toHaveLength(450);
  });

  it("reads open, partially received and billed POs in full; ignores drafts, cancelled and other SKUs", async () => {
    const { z, http } = setup();
    z.addPo({ purchaseorder_id: "1", status: "open", delivery_date: "2026-10-30", line_items: [{ item_id: "it-1", quantity: 300, quantity_received: 0 }, { item_id: "other", quantity: 99 }] });
    z.addPo({ purchaseorder_id: "2", status: "partially_received", line_items: [{ item_id: "it-1", quantity: 300, quantity_received: 100 }] });
    z.addPo({ purchaseorder_id: "3", status: "billed", line_items: [{ item_id: "it-2", quantity: 50, quantity_received: 0 }] });
    z.addPo({ purchaseorder_id: "4", status: "draft", reference_number: "FR-2026-W42-DIST001", line_items: [{ item_id: "it-1", quantity: 500 }] });
    z.addPo({ purchaseorder_id: "5", status: "cancelled", line_items: [{ item_id: "it-1", quantity: 400 }] });
    const r = await readForRun(http, { runWeek: "2026-W43", today: "2026-10-19", itemToSku, now: () => new Date("2026-10-19T03:00:00Z") });
    expect(r.poLines.map((l) => [l.poId, l.skuId, l.status, l.ordered, l.received])).toEqual([
      ["1", "SKU001", "open", 300, 0],
      ["2", "SKU001", "partially_received", 300, 100],
      ["3", "SKU002", "billed", 50, 0],
    ]);
    expect(r.poLines[0]!.expectedDate).toBe("2026-10-30");
    expect(z.writes()).toEqual([]);
  });

  it("ZO-15 receipts dated Monday or later count whatever the PO's status; Sunday's don't", async () => {
    const { z, http } = setup();
    z.addPo({ purchaseorder_id: "9", status: "received", line_items: [{ item_id: "it-1", quantity: 200, quantity_received: 200 }] });
    z.addReceive({ receive_id: "r1", date: "2026-10-18", purchaseorder_id: "9", line_items: [{ item_id: "it-1", quantity: 80 }] });
    z.addReceive({ receive_id: "r2", date: "2026-10-19", purchaseorder_id: "9", line_items: [{ item_id: "it-1", quantity: 120 }] });
    const r = await readForRun(http, { runWeek: "2026-W43", today: "2026-10-19", itemToSku, now: () => new Date("2026-10-19T03:00:00Z") });
    expect(r.receipts).toEqual([{ poId: "9", skuId: "SKU001", date: "2026-10-19", qty: 120 }]);
    expect(r.poLines).toEqual([]); // a fully received PO isn't "open" — its Monday receipt still counts
  });

  it("an unknown PO status fails closed", () => {
    expect(poStatus("Open")).toBe("open");
    expect(poStatus("partially received")).toBe("partially_received");
    expect(() => toPoLines({ purchaseorder_id: "x", purchaseorder_number: "PO-x", status: "on_hold", line_items: [] }, itemToSku)).toThrow(/Unknown Zoho purchase order status/);
  });

  it("readPo returns null for a deleted PO", async () => {
    const { http } = setup();
    expect(await readPo(http, "gone")).toBeNull();
  });
});

describe("ZO-07 mapping check and A4 unit check", () => {
  const items = new Map([
    ["it-1", { item_id: "it-1", unit: "Units", status: "active" }],
    ["it-2", { item_id: "it-2", unit: "Cases", status: "active" }],
    ["it-3", { item_id: "it-3", unit: "Units", status: "inactive" }],
  ]);
  const vendors = new Map([["v-1", { contact_id: "v-1", status: "active" }]]);
  const base = { status: "active", uom: "Units", supplierId: "DIST001", zohoVendorId: "v-1" };

  it("blocks each unmappable SKU with a reason, and leaves good and inactive ones alone", () => {
    const blocked = mappingCheck(
      [
        { ...base, id: "OK", zohoItemId: "it-1" },
        { ...base, id: "NOITEM", zohoItemId: null },
        { ...base, id: "MISSING", zohoItemId: "it-9" },
        { ...base, id: "INACTIVEITEM", zohoItemId: "it-3" },
        { ...base, id: "UNIT", zohoItemId: "it-2" },
        { ...base, id: "NOSUP", zohoItemId: "it-1", supplierId: null },
        { ...base, id: "NOVENDOR", zohoItemId: "it-1", zohoVendorId: null },
        { ...base, id: "BADVENDOR", zohoItemId: "it-1", zohoVendorId: "v-9" },
        { ...base, id: "RETIRED", zohoItemId: null, status: "inactive" },
      ],
      items,
      vendors,
    );
    expect(Object.keys(blocked).sort()).toEqual(["BADVENDOR", "INACTIVEITEM", "MISSING", "NOITEM", "NOSUP", "NOVENDOR", "UNIT"]);
    expect(blocked.UNIT).toMatch(/Unit mismatch.*Units.*Cases/);
    expect(blocked.NOVENDOR).toMatch(/Settings › Suppliers/);
  });
});

describe("draft read-back (ZO-05, ZO-06, D11)", () => {
  const requested = [{ sku_id: "SKU001", item_id: "it-1", qty: 600 }];
  const po = (status: string, qty: number, reference = "FR-2026-W43-DIST001"): ZohoPo => ({
    purchaseorder_id: "77",
    purchaseorder_number: "PO-77",
    status,
    reference_number: reference,
    line_items: [{ item_id: "it-1", quantity: qty }],
  });

  it("ZO-05 not found or cancelled → deleted (a procurement rejection)", () => {
    expect(readback(null, requested)).toEqual({ status: "deleted" });
    expect(readback(po("cancelled", 600), requested)).toEqual({ status: "deleted" });
  });

  it("still a draft → pending (blocks a new draft for that supplier, C-023b)", () => {
    expect(readback(po("draft", 600), requested)).toMatchObject({ status: "created", pending: true, changed: false });
  });

  it("ZO-06 issued with a changed quantity → edited (procurement override), even with a changed reference", () => {
    expect(readback(po("open", 500, "Supplier ref 4471"), requested)).toMatchObject({ status: "edited", pending: false, changed: true, lines: [{ item_id: "it-1", qty: 500 }] });
    expect(readback(po("open", 600), requested)).toMatchObject({ status: "issued", changed: false });
  });
});
