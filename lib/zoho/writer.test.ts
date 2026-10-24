// ST-04 (unit part) and ZO-04 (HTTP part): the writer exists only in live mode, its payload has no status,
// and a create is never retried blindly on a server error.
import { describe, expect, it } from "vitest";
import { ZohoApiError, ZohoHttp } from "./http";
import { memoryTokenSource } from "./token";
import { draftPayload, findByReference, ZohoDraftWriter } from "./writer";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";

const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };
const http = (z: FakeZoho) => new ZohoHttp({ apiBase: API, organizationId: ORG, fetch: z.fetch, token: memoryTokenSource(z.fetch, CFG), sleep: async () => {} });
const payload = draftPayload({ vendorId: "v-1", reference: "FR-2026-W43-DIST001", date: "2026-10-20", lines: [{ itemId: "it-1", qty: 240 }] });

describe("ZohoDraftWriter", () => {
  it("can't be made in shadow mode", () => {
    expect(() => ZohoDraftWriter.forMode("shadow", http(new FakeZoho()))).toThrow(/only possible in live mode/);
  });

  it("the payload carries no status, so Zoho creates a draft", () => {
    expect(Object.keys(payload).sort()).toEqual(["date", "line_items", "reference_number", "vendor_id"]);
  });

  it("creates a draft with one POST", async () => {
    const z = new FakeZoho();
    const po = await ZohoDraftWriter.forMode("live", http(z)).createDraft(payload);
    expect(po.status).toBe("draft");
    expect(z.writes()).toHaveLength(1);
  });

  it("a lost response (500) is not retried: one PO exists, found by reference", async () => {
    const z = new FakeZoho();
    z.loseNextCreateResponse = true;
    const h = http(z);
    await expect(ZohoDraftWriter.forMode("live", h).createDraft(payload)).rejects.toBeInstanceOf(ZohoApiError);
    expect(z.writes()).toHaveLength(1);
    expect((await findByReference(h, "FR-2026-W43-DIST001"))?.purchaseorder_id).toBe("new-1");
  });

  it("a 429 is retried: the request was refused, not processed", async () => {
    const z = new FakeZoho();
    z.script.push({ status: 429, headers: { "Retry-After": "1" } });
    await ZohoDraftWriter.forMode("live", http(z)).createDraft(payload);
    expect(z.pos.size).toBe(1);
  });
});
