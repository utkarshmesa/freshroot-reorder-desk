import "server-only";
// Free-plan safety net (C-042). Vercel Hobby runs cron at most once a day, so the 5-minute cron that resumed
// unfinished runs and sent alert emails is gone. Instead, whenever someone opens Upload or the Review desk, any
// unfinished run is resumed and pending alerts are emailed, after the page has been sent. Runs are claimed with a
// row lease, so this is safe alongside the daily cron and the commit trigger.
import { after } from "next/server";
import { deliverAlerts, resendSender } from "@/lib/cron/jobs";
import { caseDataMode, serviceClient } from "@/lib/db/server";
import { processPendingRuns } from "./worker";

const UNFINISHED = ["queued", "readback", "zoho_read", "mapping", "engine", "ready"];

export async function kickPendingWork(): Promise<void> {
  const db = serviceClient();
  const [{ count: runs }, { count: alerts }] = await Promise.all([
    db.from("run").select("id", { count: "exact", head: true }).is("superseded_by", null).in("status", UNFINISHED),
    db.from("alert").select("id", { count: "exact", head: true }).is("sent_at", null),
  ]);
  if (!runs && !alerts) return;
  after(async () => {
    try {
      if (runs) await processPendingRuns(db, { caseDataMode: caseDataMode() });
      await deliverAlerts(db, resendSender(), new Date());
    } catch (e) {
      console.error("background resume failed; the daily cron will retry", e);
    }
  });
}
