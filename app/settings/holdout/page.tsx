import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { saveHoldout } from "../actions";
import { Flash, SettingsNav, type SearchParams } from "../ui";

export default async function HoldoutPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const db = await userClient();
  const [{ data: skus }, { data: holdout }] = await Promise.all([
    db.from("sku").select("id, name, category, perishable, status").order("id"),
    db.from("holdout").select("sku_id"),
  ]);
  const held = new Set((holdout ?? []).map((h) => h.sku_id));
  const editable = can(session, "owner.setHoldout");

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="holdout" />
      <Flash searchParams={searchParams} />
      <p className="muted">
        Manual (holdout) SKUs: about 20%, chosen at go-live by category and perishability. Raghav plans them by hand for the whole pilot and the system hides its
        suggestions for them; they are the comparison that proves the pilot works. Only Deepa changes this list. {held.size} of {(skus ?? []).length} SKUs are
        manual now.
      </p>
      <form action={saveHoldout} className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Manual</th>
                <th>SKU</th>
                <th>Category</th>
                <th>Perishable</th>
              </tr>
            </thead>
            <tbody>
              {(skus ?? []).map((s) => (
                <tr key={s.id}>
                  <td>
                    <input type="checkbox" name="sku" value={s.id} defaultChecked={held.has(s.id)} disabled={!editable} aria-label={`Manual: ${s.id}`} />
                  </td>
                  <td>
                    {s.id} <span className="muted">{s.name}</span>
                  </td>
                  <td>{s.category ?? "—"}</td>
                  <td>{s.perishable ? "High" : "Low"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable ? (
          <div className="row" style={{ marginTop: 12 }}>
            <input name="reason" placeholder="Reason (required)" required style={{ flex: 1, minWidth: 240 }} aria-label="Reason" />
            <button className="primary">Save holdout list</button>
          </div>
        ) : (
          <p className="muted">Only Deepa can change the holdout list.</p>
        )}
      </form>
    </Shell>
  );
}
