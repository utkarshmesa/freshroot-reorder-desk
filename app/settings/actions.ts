"use server";
// Settings writes. Each action checks the role in code, then writes with the user's own client so RLS and the
// RPCs' role checks apply too (ARCHITECTURE §3.2). Every change lands in change_log via triggers.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAction } from "@/lib/auth/me";
import { serviceClient, userClient } from "@/lib/db/server";
import { isValidWeek } from "@/lib/isoweek";
import type { RuleParams } from "@/lib/rules/defaults";
import { applyRuleForm } from "@/lib/rules/form";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const optNum = (f: FormData, k: string) => (str(f, k) === "" ? null : Number(str(f, k)));
const list = (f: FormData, k: string) =>
  str(f, k)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function checkWeek(path: string, label: string, v: string | null) {
  if (v && !isValidWeek(v)) fail(path, `${label} "${v}" is not a valid ISO week (YYYY-Www)`);
}

export async function saveSku(form: FormData) {
  await requireAction("settings.editMaster");
  const path = "/settings/skus";
  const id = str(form, "id");
  if (!id) fail(path, "SKU id is required");
  const first = str(form, "first_sale_week") || null;
  checkWeek(path, "First sale week", first);
  const row = {
    id,
    name: str(form, "name"),
    category: str(form, "category") || null,
    status: str(form, "status") || "active",
    first_sale_week: first,
    launch_estimate_wk: optNum(form, "launch_estimate_wk"),
    std_qty: Number(str(form, "std_qty")),
    moq: optNum(form, "moq"),
    pack_size: optNum(form, "pack_size"),
    uom: str(form, "uom") || null,
    lead_time_wks: optNum(form, "lead_time_wks"),
    shelf_life_wks: optNum(form, "shelf_life_wks"),
    perishable: form.get("perishable") === "on",
    unit_cost_inr: optNum(form, "unit_cost_inr"),
    supplier_id: str(form, "supplier_id") || null,
    zoho_item_id: str(form, "zoho_item_id") || null,
  };
  if (!row.name || !Number.isInteger(row.std_qty) || row.std_qty <= 0) fail(path, "Name and a whole standard quantity above 0 are required");
  for (const [k, v] of Object.entries(row)) if (typeof v === "number" && Number.isNaN(v)) fail(path, `${k} must be a number`);
  const { error } = await (await userClient()).from("sku").upsert(row);
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(id)}`);
}

export async function saveDistributor(form: FormData) {
  await requireAction("settings.editMaster");
  const path = "/settings/distributors";
  const row = {
    id: str(form, "id"),
    name: str(form, "name"),
    region: str(form, "region") || null,
    status: str(form, "status") || "active",
    start_week: str(form, "start_week") || null,
    end_week: str(form, "end_week") || null,
  };
  if (!row.id || !row.name) fail(path, "Id and name are required");
  checkWeek(path, "Start week", row.start_week);
  checkWeek(path, "End week", row.end_week);
  if (row.status === "inactive" && !row.end_week) fail(path, "An inactive distributor needs an end week (D3)");
  const { error } = await (await userClient()).from("distributor").upsert(row);
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(row.id)}`);
}

export async function saveSupplier(form: FormData) {
  await requireAction("settings.editMaster");
  const path = "/settings/suppliers";
  const row = { id: str(form, "id"), name: str(form, "name"), zoho_vendor_id: str(form, "zoho_vendor_id") || null };
  if (!row.id || !row.name) fail(path, "Id and name are required");
  const { error } = await (await userClient()).from("supplier").upsert(row);
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(row.id)}`);
}

export async function publishRules(form: FormData) {
  await requireAction("settings.publishRules");
  const path = "/settings/rules";
  const reason = str(form, "reason");
  if (!reason) fail(path, "Give a reason for the change (D12): it is logged and Deepa reviews it monthly");
  const db = await userClient();
  const { data: cur, error: e1 } = await db.rpc("current_rules");
  if (e1 || !cur) fail(path, e1?.message ?? "No current rules");
  const result = applyRuleForm((cur as { params: RuleParams }).params, form);
  if (!result.ok) fail(path, result.error);
  if (!result.changed.length) fail(path, "Nothing changed");
  const { error } = await db.rpc("publish_rule_version", { p_params: result.params, p_reason: reason });
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(`Changed ${result.changed.join(", ")}; applies from the next run`)}`);
}

export async function saveEvent(form: FormData) {
  await requireAction("settings.editEvents");
  const path = "/settings/calendar";
  const type = str(form, "type");
  const row = {
    type,
    start_date: str(form, "start_date"),
    end_date: str(form, "end_date"),
    sku_ids: list(form, "sku_ids"),
    distributor_ids: list(form, "distributor_ids"),
    uplift_pct: type === "festival" ? optNum(form, "uplift_pct") : null,
    preload_wks: type === "festival" ? (optNum(form, "preload_wks") ?? 3) : 0,
    reason: str(form, "reason"),
  };
  if (!["festival", "hold"].includes(type)) fail(path, "Unknown event type");
  if (!row.start_date || !row.end_date || row.end_date < row.start_date) fail(path, "Start and end dates are required, end on or after start");
  if (!row.reason) fail(path, "A reason is required");
  if (type === "hold" && row.sku_ids.length === 0 && row.distributor_ids.length === 0) fail(path, "A hold needs at least one SKU or distributor");
  const db = await userClient();
  if (row.sku_ids.length) {
    const { data } = await db.from("sku").select("id").in("id", row.sku_ids);
    const known = new Set((data ?? []).map((r) => r.id));
    const unknown = row.sku_ids.filter((s) => !known.has(s));
    if (unknown.length) fail(path, `Unknown SKU: ${unknown.join(", ")}`);
  }
  if (row.distributor_ids.length) {
    const { data } = await db.from("distributor").select("id").in("id", row.distributor_ids);
    const known = new Set((data ?? []).map((r) => r.id));
    const unknown = row.distributor_ids.filter((s) => !known.has(s));
    if (unknown.length) fail(path, `Unknown distributor: ${unknown.join(", ")}`);
  }
  const { error } = await db.from("event").insert(row);
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${type}`);
}

export async function deleteEvent(form: FormData) {
  await requireAction("settings.editEvents");
  const { error } = await (await userClient()).from("event").delete().eq("id", str(form, "id"));
  if (error) fail("/settings/calendar", error.message);
  revalidatePath("/settings/calendar");
}

export async function saveHoldout(form: FormData) {
  await requireAction("owner.setHoldout");
  const path = "/settings/holdout";
  const reason = str(form, "reason");
  if (!reason) fail(path, "Give a reason");
  const ids = form.getAll("sku").map(String);
  const { error } = await (await userClient()).rpc("set_holdout", { p_sku_ids: ids, p_reason: reason });
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${ids.length}`);
}

export async function setMode(form: FormData) {
  await requireAction("owner.setMode");
  const path = "/settings/mode";
  const mode = str(form, "mode");
  const reason = str(form, "reason");
  if (!reason) fail(path, "Give a reason");
  const { error } = await (await userClient()).rpc("set_mode", { p_mode: mode, p_reason: reason });
  if (error) fail(path, error.message);
  revalidatePath("/", "layout");
  redirect(`${path}?saved=${mode}`);
}

const ROLES = ["uploader", "planner", "procurement", "admin", "viewer"];

export async function savePerson(form: FormData) {
  await requireAction("settings.editPeople");
  const path = "/settings/people";
  const userId = str(form, "user_id");
  const roles = ROLES.filter((r) => form.get(`role_${r}`) === "on");
  const patch = {
    name: str(form, "name"),
    roles,
    backup_for: str(form, "backup_for") || null,
    backup_from: str(form, "backup_from") || null,
    backup_to: str(form, "backup_to") || null,
  };
  // The RPC refuses changes to your own roles and never touches the owner flag.
  const { error } = await (await userClient()).rpc("admin_set_user", {
    p_user_id: userId,
    p_name: patch.name,
    p_roles: patch.roles,
    p_backup_for: patch.backup_for,
    p_backup_from: patch.backup_from,
    p_backup_to: patch.backup_to,
  });
  if (error) fail(path, error.message);
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(patch.name)}`);
}

/** Admin invites a person by email (Supabase sends the sign-in link) and gives them roles. */
export async function invitePerson(form: FormData) {
  await requireAction("settings.editPeople");
  const path = "/settings/people";
  const email = str(form, "email").toLowerCase();
  const name = str(form, "name");
  const roles = ROLES.filter((r) => form.get(`role_${r}`) === "on");
  if (!email || !name || roles.length === 0) fail(path, "Email, name and at least one role are required");
  const { data, error } = await serviceClient().auth.admin.inviteUserByEmail(email);
  if (error || !data.user) fail(path, error?.message ?? "Invite failed");
  const { error: e2 } = await (await userClient()).rpc("admin_add_user", { p_user_id: data.user.id, p_email: email, p_name: name, p_roles: roles });
  if (e2) fail(path, e2.message);
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(name)}`);
}
