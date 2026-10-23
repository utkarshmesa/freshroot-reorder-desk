// Access tokens from the one refresh token (ADR-0002). Never mints refresh tokens (Zoho keeps at most 20
// per user): only grant_type=refresh_token is ever sent. The 1-hour access token is cached in
// zoho_token_cache (service role only) so serverless invocations share it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ZohoAuthError, type Fetch, type TokenSource } from "./http";

export type TokenConfig = { accountsDomain: string; clientId: string; clientSecret: string; refreshToken: string };

const MARGIN_MS = 120_000;

/** Exchanges the refresh token for an access token. Throws ZohoAuthError when Zoho refuses. */
export async function refreshAccessToken(fetch: Fetch, cfg: TokenConfig): Promise<{ token: string; expiresIn: number }> {
  const q = new URLSearchParams({ refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" });
  const res = await fetch(`${cfg.accountsDomain}/oauth/v2/token?${q}`, { method: "POST", headers: {} });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await res.text()) as Record<string, unknown>;
  } catch {
    // reported below
  }
  if (res.status !== 200 || typeof json.access_token !== "string") {
    throw new ZohoAuthError(
      `Zoho token refresh failed: ${String(json.error ?? `HTTP ${res.status}`)}. The integration user's refresh token may be revoked (RUNBOOK: rotating the Zoho token).`,
    );
  }
  return { token: json.access_token, expiresIn: Number(json.expires_in ?? 3600) };
}

/** Production token source: cached in the database, shared by every invocation. */
export function dbTokenSource(db: SupabaseClient, cfg: TokenConfig, fetch: Fetch, now: () => number = () => Date.now()): TokenSource {
  const refresh = async (): Promise<string> => {
    const { token, expiresIn } = await refreshAccessToken(fetch, cfg);
    const { error } = await db.from("zoho_token_cache").upsert({ id: true, access_token: token, expires_at: new Date(now() + expiresIn * 1000).toISOString() });
    if (error) throw new Error(`token cache: ${error.message}`);
    return token;
  };
  return {
    async get() {
      const { data } = await db.from("zoho_token_cache").select("access_token, expires_at").eq("id", true).maybeSingle();
      if (data && Date.parse(data.expires_at as string) - MARGIN_MS > now()) return data.access_token as string;
      return refresh();
    },
    refresh,
  };
}

/** In-memory token source (tests, scripts). */
export function memoryTokenSource(fetch: Fetch, cfg: TokenConfig): TokenSource {
  let cached: string | null = null;
  const refresh = async () => (cached = (await refreshAccessToken(fetch, cfg)).token);
  return { get: async () => cached ?? refresh(), refresh };
}
