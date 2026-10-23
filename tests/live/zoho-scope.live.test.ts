// ZO-13 / ADR-0002 week-1 scope check, against the Zoho TEST org only. Milestone 1 exit blocker.
//
// Run:  ZOHO_LIVE=1 npm run test:zoho-live
// Reads ONLY .env.zoho-test (never .env.local), which must contain the TEST org's values:
//   ZOHO_ACCOUNTS_DOMAIN, ZOHO_API_DOMAIN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN,
//   ZOHO_ORGANIZATION_ID, ZOHO_LIVE_CONFIRM_ORG_ID (type the test org id again, as a deliberate confirmation),
//   ZOHO_LIVE_VENDOR_ID, ZOHO_LIVE_ITEM_ID (a vendor and item that exist in the test org).
// Optional: ZOHO_PRODUCTION_ORG_ID (refused if it equals the target), ZOHO_READONLY_REFRESH_TOKEN (ADR-0005).
//
// Safety (code review M3, finding 1): every check runs in beforeAll; if any fails, no test runs and nothing
// is sent. The org's name in Zoho must contain the word "test" or "sandbox". Each write test re-checks too.
//
// It deliberately tries to issue, update and delete a draft it created: that is the point of the check.
// Those raw requests live only here; lib/zoho has no method for them. It leaves one 1-unit draft
// (reference FR-SCOPECHECK-…) in the test org, which a person deletes afterwards.
//
// Records every response under tests/fixtures/zoho/recorded/ and writes scope-check.json there for the
// ADR-0002 results table.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const live = process.env.ZOHO_LIVE === "1";
const e = process.env;
const OUT = path.join(process.cwd(), "tests/fixtures/zoho/recorded");
const results: Record<string, unknown> = {};
let token = "";
let draftId = "";
let verified = false;

const api = (p: string, q: Record<string, string> = {}) =>
  `${e.ZOHO_API_DOMAIN}/inventory/v1${p}?${new URLSearchParams({ organization_id: e.ZOHO_ORGANIZATION_ID ?? "", ...q })}`;

async function call(name: string, method: string, url: string, body?: unknown, tok = token) {
  if (!verified) throw new Error("Refusing to call Zoho: the test org was not verified");
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
  const form = new URLSearchParams({ refresh_token: refreshToken, client_id: e.ZOHO_CLIENT_ID ?? "", client_secret: e.ZOHO_CLIENT_SECRET ?? "", grant_type: "refresh_token" });
  const res = await fetch(`${e.ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  return (await res.json()) as Record<string, unknown>;
}

function write() {
  writeFileSync(path.join(OUT, "scope-check.json"), JSON.stringify({ ran_at: new Date().toISOString(), ...results }, null, 2));
}

describe.skipIf(!live)("Zoho test-org scope check (ADR-0002)", () => {
  beforeAll(async () => {
    const need = ["ZOHO_ACCOUNTS_DOMAIN", "ZOHO_API_DOMAIN", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORGANIZATION_ID", "ZOHO_LIVE_CONFIRM_ORG_ID", "ZOHO_LIVE_VENDOR_ID", "ZOHO_LIVE_ITEM_ID"];
    const missing = need.filter((k) => !e[k]);
    if (missing.length) throw new Error(`.env.zoho-test is missing: ${missing.join(", ")}`);
    if (e.ZOHO_LIVE_CONFIRM_ORG_ID !== e.ZOHO_ORGANIZATION_ID) throw new Error("ZOHO_LIVE_CONFIRM_ORG_ID must equal ZOHO_ORGANIZATION_ID");
    if (e.ZOHO_PRODUCTION_ORG_ID && e.ZOHO_PRODUCTION_ORG_ID === e.ZOHO_ORGANIZATION_ID) throw new Error("ZOHO_ORGANIZATION_ID is the production org: refusing");

    const t = await refresh(e.ZOHO_REFRESH_TOKEN!);
    if (typeof t.access_token !== "string") throw new Error(`token refresh failed: ${String(t.error ?? "no access_token")}`);
    token = t.access_token;
    results.token_scope = t.scope ?? "(not returned)";

    // Read the org list with a plain GET (before `verified`, so `call` can't be used yet).
    const res = await fetch(`${e.ZOHO_API_DOMAIN}/inventory/v1/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const orgs = ((await res.json()) as { organizations?: Array<{ organization_id: string | number; name: string }> }).organizations ?? [];
    const mine = orgs.find((o) => String(o.organization_id) === e.ZOHO_ORGANIZATION_ID);
    if (!mine) throw new Error("ZOHO_ORGANIZATION_ID is not one of this token's organisations");
    if (!/\b(test|sandbox)\b/i.test(mine.name)) throw new Error(`Organisation "${mine.name}" is not named as a test or sandbox org: refusing to write to it`);
    results.organization = mine.name;
    mkdirSync(OUT, { recursive: true });
    verified = true;
  });

  it("reads items, vendors, open POs (status filter) and receipts (date filter)", async () => {
    const items = await call("items", "GET", api("/items", { per_page: "200" }));
    const vendors = await call("contacts-vendor", "GET", api("/contacts", { contact_type: "vendor" }));
    const statuses: Record<string, unknown> = {};
    for (const s of ["open", "issued", "partially_received", "billed", "partially_billed", "draft", "pending_approval"]) {
      const r = await call(`purchaseorders-status-${s}`, "GET", api("/purchaseorders", { status: s }));
      const pos = (r.json.purchaseorders as Array<{ status: string }>) ?? [];
      statuses[s] = { http: r.status, count: pos.length, statuses_returned: [...new Set(pos.map((p) => p.status))] };
    }
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const rc = await call("purchasereceives-dated", "GET", api("/purchasereceives", { date_start: weekAgo }));
    const receives = (rc.json.purchasereceives as Array<{ date: string }>) ?? [];
    const missing = await call("purchaseorder-not-found", "GET", api("/purchaseorders/1"));
    results.reads = {
      items: items.status,
      vendors: vendors.status,
      po_status_filters: statuses,
      receive_date_filter_works: rc.status === 200 && receives.every((r) => r.date >= weekAgo),
      not_found: { http: missing.status, code: missing.json.code, message: missing.json.message },
      rate_limit_headers: items.headers,
    };
    write();
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
    results.create_draft = { status: created.status, purchaseorder_id: draftId || null, reference: ref };
    if (draftId) {
      const back = await call("readback-draft", "GET", api(`/purchaseorders/${draftId}`));
      const search = await call("search-by-reference", "GET", api("/purchaseorders", { reference_number: ref }));
      results.create_draft = { ...(results.create_draft as object), read_back_status: (back.json.purchaseorder as Record<string, unknown> | undefined)?.status };
      results.reference_search = { status: search.status, found_immediately: ((search.json.purchaseorders as unknown[]) ?? []).length > 0 };
    }
    write();
    expect(draftId).not.toBe("");
  });

  it("CANNOT mark it issued, update it, delete it, or create one already issued", async () => {
    expect(draftId, "no draft was created, so there is nothing to test").not.toBe("");
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
    write(); // record first, then assert
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
