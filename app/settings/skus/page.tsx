import Link from "next/link";
import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import type { RuleParams } from "@/lib/rules/defaults";
import { saveSku } from "../actions";
import { Assumed, Flash, ReadOnlyNote, SettingsNav, type SearchParams } from "../ui";

type Sku = {
  id: string;
  name: string;
  category: string | null;
  status: string;
  first_sale_week: string | null;
  launch_estimate_wk: number | null;
  std_qty: number;
  moq: number | null;
  pack_size: number | null;
  uom: string | null;
  lead_time_wks: number | null;
  shelf_life_wks: number | null;
  perishable: boolean;
  unit_cost_inr: number | null;
  supplier_id: string | null;
  zoho_item_id: string | null;
};

export default async function SkusPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const db = await userClient();
  const sp = await searchParams;
  const [{ data: skus }, { data: suppliers }, { data: rules }] = await Promise.all([
    db.from("sku").select("*").order("id"),
    db.from("supplier").select("id, name, zoho_vendor_id").order("id"),
    db.rpc("current_rules"),
  ]);
  const d = (rules as { params: RuleParams } | null)?.params.defaults;
  const editable = can(session, "settings.editMaster");
  const editId = typeof sp.edit === "string" ? sp.edit : null;
  const editing: Partial<Sku> | null = editId === "new" ? { status: "active", perishable: false } : ((skus ?? []) as Sku[]).find((s) => s.id === editId) ?? null;

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="skus" />
      <Flash searchParams={searchParams} />
      <ReadOnlyNote session={session} action="settings.editMaster" />
      <p className="muted">
        Blank lead time, MOQ, shelf life or cost use the assumed defaults and are tagged <em>assumed</em> on every card. A SKU without a Zoho item or supplier
        mapping is blocked from ordering.
      </p>
      {editable && (
        <p>
          <Link className="button" href="/settings/skus?edit=new">
            Add SKU
          </Link>
        </p>
      )}

      {editable && editing && (
        <form action={saveSku} className="card grid" key={editId ?? "new"}>
          <label>
            SKU id
            <input name="id" defaultValue={editing.id} readOnly={editId !== "new"} required />
          </label>
          <label>
            Name
            <input name="name" defaultValue={editing.name} required />
          </label>
          <label>
            Category
            <input name="category" defaultValue={editing.category ?? ""} />
          </label>
          <label>
            Status
            <select name="status" defaultValue={editing.status}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
          <label>
            Standard reorder qty
            <input name="std_qty" type="number" min={1} step={1} defaultValue={editing.std_qty} required />
          </label>
          <label>
            MOQ (blank = std)
            <input name="moq" type="number" min={1} step={1} defaultValue={editing.moq ?? ""} />
          </label>
          <label>
            Pack size
            <input name="pack_size" type="number" min={1} step={1} defaultValue={editing.pack_size ?? ""} />
          </label>
          <label>
            Unit
            <input name="uom" defaultValue={editing.uom ?? ""} />
          </label>
          <label>
            Lead time (weeks, blank = {d?.leadTimeWks})
            <input name="lead_time_wks" type="number" min={0} step="any" defaultValue={editing.lead_time_wks ?? ""} />
          </label>
          <label>
            Shelf life (weeks)
            <input name="shelf_life_wks" type="number" min={0} step="any" defaultValue={editing.shelf_life_wks ?? ""} />
          </label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input name="perishable" type="checkbox" defaultChecked={editing.perishable} /> High perishability
          </label>
          <label>
            Unit cost (₹)
            <input name="unit_cost_inr" type="number" min={0} step="any" defaultValue={editing.unit_cost_inr ?? ""} />
          </label>
          <label>
            Supplier
            <select name="supplier_id" defaultValue={editing.supplier_id ?? ""}>
              <option value="">— none —</option>
              {(suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Zoho item id
            <input name="zoho_item_id" defaultValue={editing.zoho_item_id ?? ""} />
          </label>
          <label>
            First sale week (YYYY-Www)
            <input name="first_sale_week" defaultValue={editing.first_sale_week ?? ""} placeholder="2026-W43" />
          </label>
          <label>
            Launch estimate (units/week, new SKUs)
            <input name="launch_estimate_wk" type="number" min={0} step="any" defaultValue={editing.launch_estimate_wk ?? ""} />
          </label>
          <div className="row">
            <button className="primary">Save</button>
            <Link href="/settings/skus">Cancel</Link>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Status</th>
              <th>Std qty</th>
              <th>MOQ</th>
              <th>Lead time</th>
              <th>Perishable</th>
              <th>Supplier</th>
              <th>Zoho item</th>
              <th>Cost</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {((skus ?? []) as Sku[]).map((s) => {
              const vendor = (suppliers ?? []).find((x) => x.id === s.supplier_id)?.zoho_vendor_id;
              return (
                <tr key={s.id}>
                  <td>
                    <strong>{s.id}</strong>
                    <br />
                    <span className="muted">{s.name}</span>
                  </td>
                  <td>{s.status}</td>
                  <td>{s.std_qty}</td>
                  <td>{s.moq ?? <Assumed>= std</Assumed>}</td>
                  <td>{s.lead_time_wks !== null ? `${s.lead_time_wks} wks` : <Assumed>{d?.leadTimeWks} wks</Assumed>}</td>
                  <td>
                    {s.perishable ? "High" : "Low"}
                    {s.perishable && s.shelf_life_wks === null && (
                      <>
                        {" "}
                        <Assumed>max {d?.perishableMaxWks} wks</Assumed>
                      </>
                    )}
                    {s.perishable && s.shelf_life_wks !== null && <span className="muted"> · shelf {s.shelf_life_wks} wks</span>}
                  </td>
                  <td>
                    {s.supplier_id ?? <span className="err">none</span>}
                    {s.supplier_id && !vendor && <span className="err"> · vendor not mapped</span>}
                  </td>
                  <td>{s.zoho_item_id ?? <span className="err">not mapped: blocked</span>}</td>
                  <td>{s.unit_cost_inr !== null ? `₹${s.unit_cost_inr}` : <Assumed>units only</Assumed>}</td>
                  {editable && (
                    <td>
                      <Link href={`/settings/skus?edit=${encodeURIComponent(s.id)}`}>Edit</Link>
                    </td>
                  )}
                </tr>
              );
            })}
            {(skus ?? []).length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  No SKUs yet. Upload the SKU master, or add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
