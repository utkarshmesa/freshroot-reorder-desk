// Email sign-in links (ARCHITECTURE §9: magic link; invites from Settings → People). The link carries a one-time
// token hash; verifying it here sets the session cookie, then the home page sends the person to their screen.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { userClient } from "@/lib/db/server";

const TYPES: EmailOtpType[] = ["email", "magiclink", "invite", "recovery"];

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  // Redirect on the host the link was opened on: the session cookie was just set for that host.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const to = (path: string) => NextResponse.redirect(new URL(path, `${proto}://${host}`));
  if (!tokenHash || !type || !TYPES.includes(type)) return to("/login?error=link");
  const { error } = await (await userClient()).auth.verifyOtp({ type, token_hash: tokenHash });
  return error ? to("/login?error=link") : to("/");
}
