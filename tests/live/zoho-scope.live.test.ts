// ZO-13 / ADR-0002 week-1 scope check, against the Zoho TEST org only. Milestone 1 exit blocker.
//
// Run:  ZOHO_LIVE=1 npm run test:zoho-live      (needs .env.local with the test org's ZOHO_* values,
//        plus ZOHO_LIVE_VENDOR_ID and ZOHO_LIVE_ITEM_ID: a vendor and item that exist in the test org)
// Optional: ZOHO_READONLY_REFRESH_TOKEN, the preview/dev token minted with READ scopes only (ADR-0005).
//
// It records every response under tests/fixtures/zoho/recorded/ (these become the mock fixtures) and
// writes tests/fixtures/zoho/recorded/scope-check.json for the ADR-0002 results table.
//
// It deliberately tries to issue, update and delete a draft it created: that is the point of the check.
// Those raw requests live only here; lib/zoho has no method for them. It leaves one draft
// (reference FR-SCOPECHECK-…) in the test org, which a person deletes afterwards.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const live = process.env.ZOHO_LIVE === "1";
const e = process.env;
const OUT = path.join(process.cwd(), "tests/fixtures/zoho/recorded");
const results: Record<string, unknown> = {};
let token = "";
let draftId = "";

const api = (p: string, q: Record<string, string> = {}) =>
  `${e.ZOHO_API_DOMAIN || "https://www.zohoapis.in"}/inventory/v1${p}?${new URLSearchParams({ organization_id: e.ZOHO_ORGANIZATION_ID ?? "", ...q })}`;

async function call(name: string, method: string, url: string, body?: unknown, tok = token) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep text
  }
  const headers = Object.fromEntries([...res.headers.entries()].filter(([k]) => /rate|limit|retry/i.test(k)));
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ method, path: new URL(url).pathname, status: res.status, headers, body: json }, null, 2));
  return { status: res.status, json: json as Record<string, unknown>, headers };
}

async function refresh(refreshToken: string) {
  const q = new URLSearchParams({ refresh_token: refreshToken, client_id: e.ZOHO_CLIENT_ID ?? "", client_secret: e.ZOHO_CLIENT_SECRET ?? "", grant_type: "refresh_token" });
  const res = await fetch(`${e.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.in"}/oauth/v2/token?${q}`, { method: "POST" });
  return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(!live)("Zoho test-org scope check (ADR-0002)", () => {
  it("is pointed at a TEST organisation", async () => {
    mkdirSync(OUT, { recursive: true });
    const t = await refresh(e.ZOHO_REFRESH_TOKEN ?? "");
    expect(typeof t.access_token, `token refresh failed: ${JSON.stringify(t)}`).toBe("string");
    token = t.access_token as string;
    results.token_scope = t.scope ?? "(not returned)";
    const org = await call("organizations", "GET", api("/organizations"));
    const mine = ((org.json.organizations as Array<Record<string, unknown>>) ?? []).find((o) => String(o.organization_id) === e.ZOHO_ORGANIZATION_ID);
    results.organization = mine?.name;
    // Refuse to continue against anything that isn't clearly a test org.
    expect(String(mine?.name ?? ""), "the org name must contain 'test' or 'sandbox'").toMatch(/test|sandbox/i);
  });

  it("reads items, vendors, open POs (status filter) and receipts (date filter)", async () => {
    const items = await call("items", "GET", api("/items", { per_page: "200" }));
    const vendors = await call("contacts-vendor", "GET", api("/contacts", { contact_type: "vendor" }));
    const open = await call("purchaseorders-status-open", "GET", api("/purchaseorders", { status: "open" }));
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const rc = await call("purchasereceives-dated", "GET", api("/purchasereceives", { date_start: weekAgo, date_end: today }));
    const pos = (open.json.purchaseorders as Array<{ status: string }>) ?? [];
    const receives = (rc.json.purchasereceives as Array<{ date: string }>) ?? [];
    results.reads = {
      items: items.status,
      vendors: vendors.status,
      po_status_filter_works: open.status === 200 && pos.every((p) => p.status === "open"),
      receive_date_filter_works: rc.status === 200 && receives.every((r) => r.date >= weekAgo && r.date <= today),
      rate_limit_headers: items.headers,
    };
    expect(items.status).toBe(200);
  });

  it("creates a draft PO, which reads back as a draft", async () => {
    const ref = `FR-SCOPECHECK-${Date.now()}`;
    const created = await call("create-draft", "POST", api("/purchaseorders"), {
      vendor_id: e.ZOHO_LIVE_VENDOR_ID,
      reference_number: ref,
      line_items: [{ item_id: e.ZOHO_LIVE_ITEM_ID, quantity: 1 }],
    });
    draftId = String((created.json.purchaseorder as Record<string, unknown> | undefined)?.purchaseorder_id ?? "");
    const back = await call("readback-draft", "GET", api(`/purchaseorders/${draftId}`));
    const search = await call("search-by-reference", "GET", api("/purchaseorders", { reference_number: ref }));
    results.create_draft = { status: created.status, purchaseorder_id: draftId, reference: ref, read_back_status: (back.json.purchaseorder as Record<string, unknown> | undefined)?.status };
    results.reference_search = { status: search.status, found_immediately: ((search.json.purchaseorders as unknown[]) ?? []).length > 0 };
    expect(draftId).not.toBe("");
  });

  it("CANNOT mark it issued, update it, delete it, or create one already issued", async () => {
    const issue = await call("attempt-issue", "POST", api(`/purchaseorders/${draftId}/status/issued`));
    const update = await call("attempt-update", "PUT", api(`/purchaseorders/${draftId}`), { line_items: [{ item_id: e.ZOHO_LIVE_ITEM_ID, quantity: 2 }] });
    const del = await call("attempt-delete", "DELETE", api(`/purchaseorders/${draftId}`));
    const issuedCreate = await call("attempt-create-issued", "POST", api("/purchaseorders"), {
      vendor_id: e.ZOHO_LIVE_VENDOR_ID,
      reference_number: `FR-SCOPECHECK-ISSUED-${Date.now()}`,
      status: "issued",
      line_items: [{ item_id: e.ZOHO_LIVE_ITEM_ID, quantity: 1 }],
    });
    const issuedStatus = (issuedCreate.json.purchaseorder as Record<string, unknown> | undefined)?.status;
    results.forbidden = {
      mark_issued: issue.status,
      update: update.status,
      delete: del.status,
      create_with_issued_status: { http: issuedCreate.status, resulting_status: issuedStatus ?? null },
    };
    // Record first, then assert, so the JSON is written even when an assertion fails.
    write();
    expect(issue.status, "marking a PO issued must be refused").toBeGreaterThanOrEqual(400);
    expect(update.status, "updating a PO must be refused").toBeGreaterThanOrEqual(400);
    expect(del.status, "deleting a PO must be refused").toBeGreaterThanOrEqual(400);
    expect(issuedStatus === undefined || String(issuedStatus).toLowerCase() === "draft", "a create must never come back issued").toBe(true);
  });

  it.skipIf(!e.ZOHO_READONLY_REFRESH_TOKEN)("the read-only token (preview/dev) can't create", async () => {
    const t = await refresh(e.ZOHO_READONLY_REFRESH_TOKEN ?? "");
    const created = await call(
      "readonly-attempt-create",
      "POST",
      api("/purchaseorders"),
      { vendor_id: e.ZOHO_LIVE_VENDOR_ID, reference_number: `FR-SCOPECHECK-RO-${Date.now()}`, line_items: [{ item_id: e.ZOHO_LIVE_ITEM_ID, quantity: 1 }] },
      t.access_token as string,
    );
    results.readonly_token_create = created.status;
    write();
    expect(created.status).toBeGreaterThanOrEqual(400);
  });
});

function write() {
  writeFileSync(path.join(OUT, "scope-check.json"), JSON.stringify({ ran_at: new Date().toISOString(), ...results }, null, 2));
}
