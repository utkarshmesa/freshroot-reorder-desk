import "server-only";
// Zoho settings from the server environment only (CLAUDE.md: secrets never reach the client).
import type { TokenConfig } from "./token";

export type ZohoConfig = TokenConfig & { apiDomain: string; organizationId: string };

/** Null when Zoho isn't configured in this environment: the run then fails closed. */
export function zohoConfig(): ZohoConfig | null {
  const e = process.env;
  const cfg = {
    accountsDomain: e.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.in",
    apiDomain: e.ZOHO_API_DOMAIN || "https://www.zohoapis.in",
    clientId: e.ZOHO_CLIENT_ID ?? "",
    clientSecret: e.ZOHO_CLIENT_SECRET ?? "",
    refreshToken: e.ZOHO_REFRESH_TOKEN ?? "",
    organizationId: e.ZOHO_ORGANIZATION_ID ?? "",
  };
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken || !cfg.organizationId) return null;
  const allowed = /^https:\/\/(accounts\.zoho|www\.zohoapis)\.(in|com|eu|com\.au|jp|com\.cn|sa|ca)$/;
  if (!allowed.test(cfg.accountsDomain) || !allowed.test(cfg.apiDomain)) throw new Error("ZOHO_*_DOMAIN must be a Zoho data-centre host");
  return cfg;
}
