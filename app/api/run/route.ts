// Safety net for the weekly run (ARCHITECTURE §4): Vercel Cron calls this every 5 minutes; it processes any
// unfinished run. Requires CRON_SECRET (Vercel sends it as a Bearer token).
import { NextResponse, type NextRequest } from "next/server";
import { caseDataMode, serviceClient } from "@/lib/db/server";
import { deliverAlerts, resendSender } from "@/lib/cron/jobs";
import { processPendingRuns } from "@/lib/run/worker";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const db = serviceClient();
    const results = await processPendingRuns(db, { caseDataMode: caseDataMode() });
    const delivered = await deliverAlerts(db, resendSender(), new Date()); // alerts go out within 5 minutes
    return NextResponse.json({ results, delivered });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
