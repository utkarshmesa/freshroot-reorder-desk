// C-039 Zoho failsafe: download one supplier's PO sheet (CSV, opens in Excel) for procurement to place the order.
// Read with the signed-in user's client, so RLS decides who can see it (planner, procurement, admin, viewer).
import { NextResponse, type NextRequest } from "next/server";
import { canSee } from "@/lib/auth/access";
import { getSession } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";

const cell = (v: unknown) => {
  const s = String(v ?? "");
  // Quote everything; a leading = + - @ is prefixed so a spreadsheet never runs it as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session || !canSee(session, "review")) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("draft") ?? "";
  const db = await userClient();
  const { data: d } = await db.from("draft_po").select("reference, supplier_id, iso_week, mode, status, requested_lines").eq("id", id).maybeSingle();
  if (!d || d.mode !== "file") return NextResponse.json({ error: "sheet not found" }, { status: 404 });
  const lines = (d.requested_lines ?? []) as Array<{ sku_id: string; qty: number }>;
  const [{ data: skus }, { data: sup }] = await Promise.all([
    db.from("sku").select("id, name, uom").in("id", lines.map((l) => l.sku_id)),
    db.from("supplier").select("name").eq("id", d.supplier_id).maybeSingle(),
  ]);
  const sku = new Map((skus ?? []).map((s) => [s.id as string, s]));
  const rows = [
    ["reference", "week", "supplier_id", "supplier_name", "sku_id", "sku_name", "quantity", "unit"],
    ...lines.map((l) => [d.reference, d.iso_week, d.supplier_id, sup?.name ?? "", l.sku_id, sku.get(l.sku_id)?.name ?? "", l.qty, sku.get(l.sku_id)?.uom ?? ""]),
  ];
  const csv = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${d.reference}.csv"`, "Cache-Control": "no-store" },
  });
}
