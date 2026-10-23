// Zoho Inventory HTTP layer (ADR-0002, ARCHITECTURE §5). No env, no database: everything is injected,
// so tests drive it with an in-memory Zoho and a fake clock.
//
// - Auth: "Authorization: Zoho-oauthtoken <access token>". A 401 refreshes once, then fails closed.
// - Retries: 429 and 5xx with exponential backoff (1 s → 16 s, 5 tries), honouring Retry-After.
// - Rate limit: at most `perMinute` calls in any rolling minute (default 90, under Zoho's 100).
// - Budget: a hard cap on calls per run (default 300); exceeding it fails closed.

export class ZohoAuthError extends Error {
  override name = "ZohoAuthError";
}
export class ZohoBudgetError extends Error {
  override name = "ZohoBudgetError";
}
export class ZohoApiError extends Error {
  override name = "ZohoApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type TokenSource = { get(): Promise<string>; refresh(): Promise<string> };

export type HttpOptions = {
  apiBase: string; // e.g. https://www.zohoapis.in/inventory/v1
  organizationId: string;
  fetch: Fetch;
  token: TokenSource;
  budget?: number;
  perMinute?: number;
  maxTries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class ZohoHttp {
  private calls = 0;
  private stamps: number[] = [];
  private readonly budget: number;
  private readonly perMinute: number;
  private readonly maxTries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: HttpOptions) {
    this.budget = o.budget ?? 300;
    this.perMinute = o.perMinute ?? 90;
    this.maxTries = o.maxTries ?? 5;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** API calls made so far (token refreshes are not counted: they go to the accounts host). */
  get callCount(): number {
    return this.calls;
  }

  private async throttle(): Promise<void> {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.perMinute) {
      await this.sleep(60_000 - (t - this.stamps[0]!) + 1);
      return this.throttle();
    }
    this.stamps.push(this.now());
  }

  /** GET a JSON resource. `path` is relative to apiBase, e.g. "/purchaseorders". */
  async get<T = Record<string, unknown>>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const q = new URLSearchParams({ organization_id: this.o.organizationId });
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    return this.request<T>("GET", `${this.o.apiBase}${path}?${q}`);
  }

  /** POST JSON. Only the draft writer (milestone 5) uses this. */
  async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    const q = new URLSearchParams({ organization_id: this.o.organizationId });
    return this.request<T>("POST", `${this.o.apiBase}${path}?${q}`, JSON.stringify(body));
  }

  private async request<T>(method: string, url: string, body?: string): Promise<T> {
    let token = await this.o.token.get();
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      if (this.calls >= this.budget) throw new ZohoBudgetError(`Zoho call budget of ${this.budget} per run reached; the run is blocked (fail closed).`);
      await this.throttle();
      this.calls++;
      const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await this.o.fetch(url, { method, headers, body });
      const text = await res.text();
      const json = parse(text);

      if (res.status === 401) {
        if (refreshed) throw new ZohoAuthError(`Zoho rejected the refreshed access token (${messageOf(json, text)})`);
        token = await this.o.token.refresh();
        refreshed = true;
        attempt--;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxTries) throw new ZohoApiError(`Zoho ${method} failed after ${attempt} tries: HTTP ${res.status} ${messageOf(json, text)}`, res.status);
        const after = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }
      const code = typeof json?.code === "number" ? (json.code as number) : 0;
      if (res.status >= 400 || code !== 0) throw new ZohoApiError(`Zoho ${method} ${pathOf(url)}: HTTP ${res.status} ${messageOf(json, text)}`, res.status, code);
      return json as T;
    }
  }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const messageOf = (json: Record<string, unknown> | null, text: string) => String(json?.message ?? text.slice(0, 200));
const pathOf = (url: string) => new URL(url).pathname;
