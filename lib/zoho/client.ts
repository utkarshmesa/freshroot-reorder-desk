import "server-only";
// Production Zoho client: env config, global fetch, DB-cached access token.
import type { SupabaseClient } from "@supabase/supabase-js";
import { zohoConfig } from "./config";
import { ZohoHttp, type Fetch } from "./http";
import { dbTokenSource } from "./token";

export type ZohoFactory = (db: SupabaseClient, budget: number) => ZohoHttp | null;

/** Null when Zoho isn't configured: the run then fails closed. */
export const productionZoho: ZohoFactory = (db, budget) => {
  const cfg = zohoConfig();
  if (!cfg) return null;
  const f: Fetch = (url, init) => fetch(url, init);
  return new ZohoHttp({ apiBase: `${cfg.apiDomain}/inventory/v1`, organizationId: cfg.organizationId, fetch: f, token: dbTokenSource(db, cfg, f), budget });
};
