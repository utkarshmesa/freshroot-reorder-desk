import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { deleteEvent, saveEvent } from "../actions";
import { Flash, ReadOnlyNote, SettingsNav, type SearchParams } from "../ui";

type Ev = { id: string; type: string; start_date: string; end_date: string; sku_ids: string[]; distributor_ids: string[]; uplift_pct: number | null; preload_wks: number; reason: string };

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const { data } = await (await userClient()).from("event").select("*").order("start_date");
  const events = (data ?? []) as Ev[];
  const festivals = events.filter((e) => e.type === "festival");
  const holds = events.filter((e) => e.type === "hold");
  const editable = can(session, "settings.editEvents");
  const nextYear = new Date().getFullYear() + 1;
  const missingNextYear = !festivals.some((f) => f.start_date.startsWith(String(nextYear)));

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="calendar" />
      <Flash searchParams={searchParams} />
      <ReadOnlyNote session={session} action="settings.editEvents" />

      <h2>Festival calendar</h2>
      {missingNextYear && <div className="banner info">No festival dates for {nextYear} yet. Raghav enters next year&apos;s dates each January; the run warns until then.</div>}
      <p className="muted">The uplift applies to forward demand when the weeks being ordered for touch a festival or its pre-load window, never to past sales.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Uplift</th>
              <th>Pre-load</th>
              <th>Reason</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {festivals.map((e) => (
              <tr key={e.id}>
                <td>{e.start_date}</td>
                <td>{e.end_date}</td>
                <td>{e.uplift_pct ?? "rule default"}%</td>
                <td>{e.preload_wks} wks</td>
                <td>{e.reason}</td>
                {editable && (
                  <td>
                    <form action={deleteEvent}>
                      <input type="hidden" name="id" value={e.id} />
                      <button>Remove</button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <form action={saveEvent} className="card grid" style={{ marginTop: 12 }}>
          <input type="hidden" name="type" value="festival" />
          <label>
            From
            <input name="start_date" type="date" required />
          </label>
          <label>
            To
            <input name="end_date" type="date" required />
          </label>
          <label>
            Uplift %
            <input name="uplift_pct" type="number" min={0} step="any" defaultValue={25} />
          </label>
          <label>
            Pre-load weeks
            <input name="preload_wks" type="number" min={0} step={1} defaultValue={3} />
          </label>
          <label>
            Name / reason
            <input name="reason" placeholder="Diwali 2027" required />
          </label>
          <div className="row">
            <button className="primary">Add festival</button>
          </div>
        </form>
      )}

      <h2>Holds</h2>
      <p className="muted">
        For anything the rules can&apos;t know: promotions, competitor moves, credit holds, one-off bulk orders, pack changes. Held SKUs go to Raghav; held
        distributor-weeks are left out of the averages.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>SKUs</th>
              <th>Distributors</th>
              <th>Reason</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {holds.map((e) => (
              <tr key={e.id}>
                <td>{e.start_date}</td>
                <td>{e.end_date}</td>
                <td>{e.sku_ids.join(", ") || "all"}</td>
                <td>{e.distributor_ids.join(", ") || "all"}</td>
                <td>{e.reason}</td>
                {editable && (
                  <td>
                    <form action={deleteEvent}>
                      <input type="hidden" name="id" value={e.id} />
                      <button>Remove</button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
            {holds.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No holds.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editable && (
        <form action={saveEvent} className="card grid" style={{ marginTop: 12 }}>
          <input type="hidden" name="type" value="hold" />
          <label>
            From
            <input name="start_date" type="date" required />
          </label>
          <label>
            To
            <input name="end_date" type="date" required />
          </label>
          <label>
            SKUs (comma-separated)
            <input name="sku_ids" placeholder="SKU001, SKU004" />
          </label>
          <label>
            Distributors (comma-separated)
            <input name="distributor_ids" placeholder="DIST001" />
          </label>
          <label>
            Reason
            <input name="reason" placeholder="Diwali scheme on SKU001" required />
          </label>
          <div className="row">
            <button className="primary">Add hold</button>
          </div>
        </form>
      )}
    </Shell>
  );
}
