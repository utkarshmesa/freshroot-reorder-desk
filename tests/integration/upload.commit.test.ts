// Upload → staging → commit against the local Supabase. Tests run in order and build on each other.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addWeeks, sundayOf } from "@/lib/isoweek";
import { commitUpload, confirmUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { as, resetData, service } from "./db";

const ROOT = path.resolve(__dirname, "../..");
const file = (rel: string) => toInputFile(path.basename(rel), new Uint8Array(readFileSync(path.join(ROOT, rel))));
const text = (name: string, s: string) => toInputFile(name, new TextEncoder().encode(s));

async function stage(files: ReturnType<typeof file>[], caseDataMode = false) {
  const { client, id } = await as("priya");
  return stageUpload({ user: client, service: service(), userId: id, files, caseDataMode });
}
async function commit(uploadId: string) {
  return commitUpload((await as("priya")).client, uploadId);
}
type Query = ReturnType<ReturnType<ReturnType<typeof service>["from"]>["select"]>;
const count = async (table: string, filter?: (q: Query) => Query) => {
  let q = service().from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw new Error(error.message);
  return n ?? 0;
};

const CASE = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) => `data/case/${f}.csv`);
const SKUS = Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`);

describe("M1 exit: case files load (case-data mode)", () => {
  let runWeek: string | null = null;

  beforeAll(async () => {
    await resetData();
    const { uploadId, report } = await stage(CASE.map(file), true);
    expect(report.errors).toBe(0);
    const res = await commit(uploadId);
    runWeek = res.run_week;
  });

  it("loads 15 SKUs, 4 suppliers, the ALL distributor, 240 sales rows and 15 stock rows", async () => {
    // Other test files may add their own rows; count the case IDs.
    expect(await count("sku", (q) => q.like("id", "SKU%"))).toBe(15);
    expect(await count("supplier", (q) => q.like("id", "DIST%"))).toBe(4);
    expect(await count("distributor", (q) => q.eq("id", "ALL"))).toBe(1);
    expect(await count("sales_fact")).toBe(240);
    expect(await count("stock_snapshot")).toBe(15);
    expect(await count("event", (q) => q.eq("type", "festival"))).toBe(4);
  });

  it("creates the 2026-W43 run in shadow mode with the current rules", async () => {
    expect(runWeek).toBe("2026-W43");
    const { data } = await service().from("run").select("iso_week, status, mode, rule_version_id, spot_check_seed").eq("iso_week", "2026-W43").single();
    expect(data).toMatchObject({ iso_week: "2026-W43", status: "queued", mode: "shadow" });
    expect(data!.rule_version_id).not.toBeNull();
    expect(data!.spot_check_seed).not.toBeNull();
  });

  it("keeps the case stock as at Sunday 18 Oct 23:59 IST (C-003)", async () => {
    const { data } = await service().from("stock_snapshot").select("as_of_ts").limit(1).single();
    expect(new Date(data!.as_of_ts).toISOString()).toBe("2026-10-18T18:29:00.000Z");
  });

  it("logs master-data inserts in change_log with the uploader as actor", async () => {
    const { data } = await service().from("change_log").select("by").eq("entity", "sku").eq("entity_id", "SKU001").limit(1).single();
    expect(data!.by).toBe((await as("priya")).id);
  });
});

describe("UP-01 duplicate file rejected", () => {
  it("validation rejects a file whose hash was committed", async () => {
    const { report } = await stage([file("data/case/weekly_sales.csv")], true);
    expect(report.issues.map((i) => i.code)).toContain("duplicate_hash");
  });

  it("the database also refuses a forged staged upload carrying a committed hash", async () => {
    const svc = service();
    const hash = file("data/case/weekly_sales.csv").hash;
    const { data: up } = await svc
      .from("upload")
      .insert({ hashes: [hash], status: "staged", validation_report: { errors: 0, unconfirmed: 0 }, by: (await as("priya")).id })
      .select("id")
      .single();
    await expect(commit(up!.id)).rejects.toThrow(/duplicate key|upload_hash/);
  });
});

describe("UP-07 restatement within 12 weeks accepted; older rejected", () => {
  it("restates W40 for SKU001 and logs it", async () => {
    const { uploadId, report } = await stage([text("restate.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W40,SKU001,ALL,270,3\n")]);
    expect(report.errors).toBe(0);
    expect(report.restatedWeeks).toEqual(["2026-W40"]);
    const res = await commit(uploadId);
    expect(res.restated_weeks).toEqual(["2026-W40"]);
    const { data } = await service().from("sales_fact").select("shipped_units, returns_units").match({ sku_id: "SKU001", iso_week: "2026-W40" }).single();
    expect(data).toEqual({ shipped_units: 270, returns_units: 3 });
    const { data: log } = await service().from("change_log").select("old, new").eq("entity", "sales_fact").eq("entity_id", "SKU001|ALL|2026-W40").single();
    expect(log).toEqual({ old: [267, 0, null], new: [270, 3, null] });
  });

  it("W30 is locked in validation and in the database", async () => {
    const { report } = await stage([text("old.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W30,SKU001,ALL,1,0\n")]);
    expect(report.issues.map((i) => i.code)).toContain("restatement_locked");

    const svc = service();
    const { data: up } = await svc.from("upload").insert({ hashes: ["forged-w30"], status: "staged", validation_report: { errors: 0, unconfirmed: 0 }, by: (await as("priya")).id }).select("id").single();
    await svc.from("upload_staging").insert({ upload_id: up!.id, kind: "sales", row: { sku_id: "SKU001", distributor_id: "ALL", iso_week: "2026-W30", shipped_units: 1, returns_units: 0 } });
    await expect(commit(up!.id)).rejects.toThrow(/locked/);
  });
});

describe("UP-06 partial set not committed", () => {
  it("valid sales + invalid stock → rejected, nothing staged, nothing loaded", async () => {
    const { uploadId, report } = await stage([
      text("sales_w43.csv", `iso_week,sku_id,distributor_id,shipped_units,returns_units\n${SKUS.map((s) => `2026-W43,${s},ALL,100,0`).join("\n")}\n`),
      text("stock_w43.csv", `as_of_ts,sku_id,on_hand_units\n2026-10-25,SKU001,-5\n`),
    ]);
    expect(report.errors).toBeGreaterThan(0);
    expect(await count("upload_staging", (q) => q.eq("upload_id", uploadId))).toBe(0);
    await expect(commit(uploadId)).rejects.toThrow(/rejected|validation errors/);
    expect(await count("sales_fact", (q) => q.eq("iso_week", "2026-W43"))).toBe(0);
  });

  it("a database error mid-commit rolls everything back", async () => {
    const svc = service();
    const { data: up } = await svc.from("upload").insert({ hashes: ["forged-rollback"], status: "staged", validation_report: { errors: 0, unconfirmed: 0 }, by: (await as("priya")).id }).select("id").single();
    await svc.from("upload_staging").insert([
      { upload_id: up!.id, kind: "sales", row: { sku_id: "SKU001", distributor_id: "ALL", iso_week: "2026-W43", shipped_units: 5, returns_units: 0 } },
      { upload_id: up!.id, kind: "sales", row: { sku_id: "NOPE", distributor_id: "ALL", iso_week: "2026-W43", shipped_units: 5, returns_units: 0 } },
    ]);
    await expect(commit(up!.id)).rejects.toThrow(/foreign key/);
    expect(await count("sales_fact", (q) => q.eq("iso_week", "2026-W43"))).toBe(0);
    expect(await count("upload_hash", (q) => q.eq("hash", "forged-rollback"))).toBe(0);
    const { data } = await svc.from("upload").select("status").eq("id", up!.id).single();
    expect(data!.status).toBe("staged");
  });
});

describe("UP-04 leading-zero IDs survive into the database", () => {
  it("stores 00123 as text", async () => {
    const { uploadId, report } = await stage([text("sku.csv", "id,name,std_qty,perishable,supplier_id\n00123,Leading Zero Snack,100,false,DIST001\n")]);
    expect(report.errors).toBe(0);
    await commit(uploadId);
    const { data } = await service().from("sku").select("id").eq("id", "00123").single();
    expect(data!.id).toBe("00123");
  });
});

describe("UP-02 + C-023d: same as-of is a correction that supersedes the run", () => {
  it("re-uploads Sunday 18 Oct stock, gets a new W43 run, the old one is superseded", async () => {
    const { data: before } = await service().from("run").select("id").eq("iso_week", "2026-W43").is("superseded_by", null).single();
    const { uploadId, report } = await stage([text("stock_fix.csv", `as_of_ts,sku_id,on_hand_units\n${[...SKUS, "00123"].map((s) => `2026-10-18,${s},500`).join("\n")}\n`)]);
    expect(report.errors).toBe(0);
    expect(report.issues.map((i) => i.code)).toContain("stock_correction");
    const res = await commit(uploadId);
    expect(res.superseded_run).toBe(before!.id);
    const { data: old } = await service().from("run").select("status, superseded_by").eq("id", before!.id).single();
    expect(old).toEqual({ status: "superseded", superseded_by: res.run_id });
  });

  it("an older as-of is refused by the database even if staged", async () => {
    const svc = service();
    const { data: up } = await svc.from("upload").insert({ hashes: ["forged-old"], status: "staged", as_of_ts: "2026-10-11T23:59:00+05:30", validation_report: { errors: 0, unconfirmed: 0 }, by: (await as("priya")).id }).select("id").single();
    await svc.from("upload_staging").insert({ upload_id: up!.id, kind: "stock", row: { sku_id: "SKU001", as_of_ts: "2026-10-11T23:59:00+05:30", on_hand_units: 1 } });
    await expect(commit(up!.id)).rejects.toThrow(/older/);
  });
});

describe("UP-09 + UP-10: weekly uploads W43 → W52 → W53 → 2027-W01", () => {
  it("commits each week in turn; a ±40% volume change needs a confirm first", async () => {
    let week = "2026-W43";
    for (let i = 0; i < 11; i++) {
      const sales = `iso_week,sku_id,distributor_id,shipped_units,returns_units\n${SKUS.map((s) => `${week},${s},ALL,100,0`).join("\n")}\n`;
      const stock = `as_of_ts,sku_id,on_hand_units\n${[...SKUS, "00123"].map((s) => `${sundayOf(week)},${s},400`).join("\n")}\n`;
      const { uploadId, report } = await stage([text(`sales_${week}.csv`, sales), text(`stock_${week}.csv`, stock)]);
      expect(report.errors, `${week}: ${JSON.stringify(report.issues.filter((x) => x.level === "error"))}`).toBe(0);
      if (report.unconfirmed > 0) {
        await expect(commit(uploadId)).rejects.toThrow(/Confirm/);
        const { client } = await as("priya");
        await confirmUpload({ user: client, service: service(), uploadId, confirmedCodes: report.issues.filter((x) => x.level === "confirm").map((x) => x.code) });
      }
      const res = await commit(uploadId);
      expect(res.run_week).toBe(addWeeks(week, 1));
      week = addWeeks(week, 1);
    }
    expect(week).toBe("2027-W01");
    const { data } = await service().from("run").select("iso_week").is("superseded_by", null).order("created_at");
    expect(data!.map((r) => r.iso_week).slice(-3)).toEqual(["2026-W52", "2026-W53", "2027-W01"]);
  });

  it("the database refuses 2027-W53", async () => {
    const { error } = await service().from("backfill_sales").insert({ sku_id: "SKU001", distributor_id: "ALL", iso_week: "2027-W53", shipped_units: 1 });
    expect(error?.message).toMatch(/check constraint/);
    const ok = await service().from("backfill_sales").insert({ sku_id: "SKU001", distributor_id: "ALL", iso_week: "2026-W53", shipped_units: 1 });
    expect(ok.error).toBeNull();
  });
});
