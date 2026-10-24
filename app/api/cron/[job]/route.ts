// Scheduled jobs (ARCHITECTURE §4.1, §10), called by Vercel Cron with CRON_SECRET as a Bearer token.
//   /api/cron/noon         daily 12:00 IST: Tuesday rule (D8, C-024), send, rejection alarm, stale drafts
//   /api/cron/upload-check Mon 10:00 IST: missed-upload alert
import { NextResponse, type NextRequest } from "next/server";
import { deliverAlerts, noonJob, resendSender, uploadCheck } from "@/lib/cron/jobs";
import { serviceClient } from "@/lib/db/server";

export const maxDuration = 300;

export async function GET(request: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { job } = await ctx.params;
  const db = serviceClient();
  const now = new Date();
  try {
    let result: unknown;
    if (job === "noon") result = await noonJob(db, now);
    else if (job === "upload-check") result = { alerted: await uploadCheck(db, now) };
    else return NextResponse.json({ error: `unknown job ${job}` }, { status: 404 });
    const delivered = await deliverAlerts(db, resendSender(), now);
    return NextResponse.json({ job, result, delivered });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
