# Architecture: Freshroots Reorder Desk

Status: **Draft for review** (Step 1, revised after the LLM council; see `COUNCIL_STEP1.md`) · Implements `BUILD_PLAN.md` v1.2 (locked) + `CHANGES.md` C-001…C-012, C-013 (procurement read-only), C-015…C-018 and C-022…C-027 (all approved 23 Oct 2026).
Anything here that looks like new scope is flagged **[PENDING C-0xx]** and is not built until approved.

---

## 1. Requirements

### 1.1 Functional (from BUILD_PLAN §3, §8, §10)
1. Accept Monday SAP exports (CSV/XLSX), validate, commit all-or-nothing (§7).
2. Read Zoho open POs, receipts, items, vendors and the system's own drafts (§8.1–8.3).
3. Compute one recommendation per active SKU with Raghav's rules (§8.4–8.5), deterministically.
4. Triage: auto / queue / spot-check / info / deadline rule (D8, D9, D16, C-001, C-002, C-008).
5. Claude writes a reason per queue card and a weekly brief; numbers are checked (D13).
6. Review desk: approve / change / reject; "Send to procurement" creates Zoho drafts (live mode only, D17).
7. Settings with logged rule versions (D12), festivals and holds (D4), holdout list, people and backups.
8. Outcomes: pilot vs manual, order speed, decision log, CEO brief (§8.10).
9. Instructions page with ⚙ values bound live to Settings (§10.5).
10. Replay script for the day-45 gate (off-map), reusing the same engine.

### 1.2 Non-functional
| Concern | Target | Source |
|---|---|---|
| Weekly run (upload commit → queue ready) | < 15 min; queue ready by ~09:00 IST | INSTRUCTIONS §2 |
| Zoho calls | ≤ 300 per run, ≤ 100/min | §9 |
| Correctness | W43 reference reproduced exactly; engine deterministic (same inputs → same outputs) | §13 |
| Fail closed | Missing file, stale data, Zoho/auth failure → whole run blocked + alert | CLAUDE.md |
| LLM | Never blocks the run; never sets a number | D13 |
| Security | Secrets server-only; RLS on every table; least-privilege Zoho scopes | CLAUDE.md, D19 |
| Auditability | Every rule/settings change, decision, draft and restatement logged | D11, D12, D14 |
| Availability | Business hours, weekly cadence. A failed run can be re-run; Raghav's manual fallback exists | INSTRUCTIONS §6 |

### 1.3 Constraints
- Stack fixed: Next.js (App Router, TS strict) on Vercel, Supabase, Vercel Cron, Anthropic API, Zoho Inventory API (India DC).
- No SAP integration. 3-person IT team will run it: prefer few moving parts over clever ones.
- One language (TypeScript). The rules engine is pure (no I/O).

### 1.4 Load estimate (full rollout)
- 400 SKUs × up to 1,200 distributors. Real sales are sparse; assume ~100 SKUs per distributor → **~120k sales rows per week** (a few MB of CSV), **~19M rows for the 3-year backfill**.
- Engine look-back: 12 clean weeks plus exclusions; load **26 weeks** of distributor-level rows (~3M rows max) in SKU batches, not all at once.
- Queue: ~47% exceptions in stress tests before triage → after D8 triage, target tens of cards, not 190.

---

## 2. High-level design

```
            ┌───────────── Browser (5 screens, role-gated) ─────────────┐
            │ Upload · Review desk · Settings · Outcomes · Instructions │
            └──────────────┬──────────────────────────────▲─────────────┘
                 Server Actions (user JWT → RLS)           │ reads (RLS)
                           │                               │
┌──────────────────────────▼───────────────────────────────┴───────────────┐
│ Next.js on Vercel (server only below this line)                          │
│                                                                          │
│  lib/upload ── parse + validate ──► staging ──► commit_upload() (1 tx)   │
│                                                     │ commit triggers    │
│  app/api/run/worker  ◄── Vercel Cron (safety net) ──┘                    │
│     │  state machine: zoho_read → mapping → readback → engine → triage   │
│     │                 → persist → llm → done                             │
│     ├─► lib/zoho (READ client)  ──────────────► Zoho Inventory API       │
│     ├─► lib/engine (PURE)                                                │
│     └─► lib/llm  ──────────────────────────────► Anthropic API           │
│                                                                          │
│  app/api/send-to-procurement ─► lib/zoho (WRITE client, live mode only)  │
│  app/api/cron/* (IST schedule) ─► lib/alerts (email)                     │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ service role (worker/cron only)
                  ┌────────▼─────────┐
                  │ Supabase         │ Postgres (RLS) · Auth · Storage
                  └──────────────────┘   (bucket `uploads`, private)
```

### 2.1 Module boundaries

| Module | Rule | May import | Must not import |
|---|---|---|---|
| `lib/engine/` | **Pure.** Input: plain typed objects. Output: recommendations. No `Date.now()`, no randomness (spot-check seed is an input), no env, no I/O. | `lib/isoweek` | anything else |
| `lib/isoweek/` | Pure ISO-week maths (W53, week arithmetic, Monday/Sunday boundaries in IST). | — | — |
| `lib/upload/` | Parse (CSV/XLSX, all cells as strings), detect file type from headers, validate, produce a staging set + report. Parsing/validation is pure; storage writes live in `lib/upload/server.ts`. | `lib/isoweek` | `lib/zoho`, `lib/llm` |
| `lib/zoho/` | `import 'server-only'`. OAuth refresh, retries, rate limiter, mappers to engine types. Two clients: **`ZohoReader`** and **`ZohoDraftWriter`**; the writer is only constructible via `getDraftWriter(mode)`, which throws unless `mode === 'live'` (D17 code guard). No method exists for update, delete, issue or status change. | `lib/isoweek` | `lib/llm` |
| `lib/llm/` | `import 'server-only'`. Prompt builders (numbers + anonymised codes only), number checker, template fallback, name insertion. | engine **types** only | `lib/zoho` |
| `lib/outcomes/` | Pure. Stockout weeks, loss, rates, pilot vs manual. Shared by the Outcomes page and the replay. | `lib/isoweek` | I/O |
| `lib/run/` | Orchestrator: loads data, calls Zoho reader, engine, triage, LLM, persists. The only place these meet. | all of the above | — |
| `lib/db/` | Supabase clients: `userClient()` (user JWT, RLS applies) and `serviceClient()` (`server-only`, used by run worker and cron only). | — | — |
| `scripts/replay/` | Node script; reuses `lib/engine` + `lib/isoweek` verbatim; reads backfill from DB or files. | engine, isoweek | `lib/zoho`, `lib/llm` |

Enforced by an ESLint `no-restricted-imports` rule per folder plus a unit test that greps `lib/engine` for `fetch|process.env|Date.now|Math.random|supabase`.

---

## 3. Data model (Postgres)

All tables from BUILD_PLAN §6, with the columns listed there. Additions are **implementation detail only** (keys, audit columns, staging, user roles); none change behaviour.

### 3.1 Tables

| Table | Key / notable columns (beyond §6) |
|---|---|
| `sku` | PK `id text`. `perishable bool`, nullable `lead_time_wks`, `moq`, `shelf_life_wks`, `pack_size`, `unit_cost_inr`, `launch_estimate_wk`. Engine reports which D18 defaults were applied (`assumed[]` on the recommendation). |
| `distributor` | PK `id text`. `start_week`, `end_week` as ISO-week text `YYYY-Www`. Case-data mode seeds a synthetic `ALL` row (C-011). |
| `supplier` | PK `id text` (e.g. `DIST001` in case data), `zoho_vendor_id`. |
| `event` | `type in ('festival','hold')`, `start_date`, `end_date` (IST dates), `sku_ids text[]`, `distributor_ids text[]`, `uplift_pct`, `preload_wks` (default 3), `reason`, `created_by`. |
| `rule_version` | `params jsonb` (bands, HD ratio, HD multiplier, festival uplift, preload, borderline %, auto cap ×, D18 defaults, restatement window, Tuesday deadline, spot-check count). Exactly one is current (`is_current`, partial unique index). New version applies from the next run (D12). |
| `change_log` | Append-only. Written by triggers on `sku`, `distributor`, `supplier`, `event`, `rule_version`, `holdout`, `app_setting`, `sales_fact` (restatements). `reason` required for rules (D12). |
| `upload` | `files text[]`, `hashes text[]` (unique per hash across committed uploads), `as_of_ts timestamptz`, `status in ('staged','rejected','committed')`, `validation_report jsonb`, `case_data bool`. |
| `upload_staging` | `upload_id`, `kind`, `row jsonb`. Rows wait here until commit; deleted on commit/reject. |
| `sales_fact` | PK `(sku_id, distributor_id, iso_week)`; `upload_id`. Restatement = upsert + `change_log` row; locked if older than 12 weeks (D14, enforced in `commit_upload`). |
| `stock_snapshot` | PK `(sku_id, as_of_ts)`. One per SKU per Sunday. Weekly history accumulates → zero-stock exclusion and outcomes (C-007). |
| `run` | `iso_week`, `upload_id`, `rule_version_id`, `mode` (shadow/live at run time), `zoho_read jsonb` (raw normalised read, with `read_at`), `status` (state machine, §4), `locked_until timestamptz` (row lease, §4), `step_attempts int`, `error jsonb`, `spot_check_seed bigint` (stored so the draw is reproducible), `superseded_by` for re-runs (§4.2). One current run per `iso_week`. |
| `recommendation` | §6 columns + `inputs jsonb` (a12, a4, F, P breakdown, band, min_eff, festival weeks), `assumed text[]`, `holdout bool`, `days_to_stockout numeric`, `reason_source in ('llm','template')`. `triage` values: `auto, queue, spotcheck, deadline_auto, rolled, none, info_no_open_po` (C-001). |
| `decision` | §6 columns. `reason_code` from `reason_code` lookup (C-010). One current decision per recommendation; re-approval (C-009) is a new row with `status='reapproved'`. |
| `draft_po` | §6 columns + `iso_week`, `mode`, `created_at`, `issued_at`, `requested_lines jsonb`, `last_read_at`. `status in ('creating','created','issued','edited','deleted','skipped_pending','shadow')`. Unique `(reference) where mode='live'` and unique `(supplier_id, iso_week) where mode='live'`; **shadow rows never block live rows**. `zoho_po_id` is the readback key (§5). |
| `holdout` | PK `sku_id`. Admin (owner) only. |
| `brief` | `run_id`, `text`, `checked bool`, `source in ('llm','template')`. |
| `app_user` | `user_id uuid` → `auth.users`, `name`, `email`, `roles text[]` ⊆ {uploader, planner, procurement, admin, viewer}, `is_owner bool` (Deepa: mode, holdout, deadlines), `backup_for text`, `backup_from`, `backup_to`. |
| `app_setting` | Singleton: Zoho DC, alert recipients. |
| `app_mode` | Singleton: `mode` (`shadow` default), `changed_by`, `changed_at`. A separate table because RLS works on rows, not columns; written only via `set_mode()` RPC (owner check inside). |
| `zoho_token_cache` | Access token + expiry only (never the refresh token). RLS denies every role; only the service role reads/writes. Shared across serverless invocations so we don't mint a token per call. |
| `reason_code` | `code`, `label`, `active` (C-010). |
| `alert` | `kind`, `run_id`, `to text[]`, `sent_at`, `payload jsonb`. Idempotency for cron emails. |

### 3.2 RLS per role (D19)

RLS is **on for every table**. Helper `has_role(r text)` reads `app_user.roles` for `auth.uid()`; `is_owner()` likewise. User-initiated writes go through Server Actions with the **user's JWT** so RLS applies. Only the run worker and cron use the service role.

| Table | Uploader | Planner | Procurement | Admin | Viewer |
|---|---|---|---|---|---|
| `upload`, `upload_staging` | R/W own | R | — | R | — |
| `sales_fact`, `stock_snapshot` | R (write only via `commit_upload` RPC, `security definer`) | R | R | R | — |
| `sku`, `distributor`, `supplier` | R | R/W | R (+ supplier-detail columns, see note) | R/W | R |
| `event` (festivals, holds) | R | R/W | R | R | R |
| `rule_version` | R | **insert** (new version) | R | R | R |
| `holdout`, `app_setting.mode` | R | R | R | **W if `is_owner`** | R |
| `run`, `recommendation` | R (status only) | R | R | R | R (`holdout` rows hidden from all UI by view) |
| `decision` | — | R/W | R | R | R |
| `draft_po` | — | R | R | R | R |
| `brief` | — | R | R | R | **R** |
| `change_log` | R | R | R | R | R |
| `app_user`, `reason_code` | R self | R / R | R self | R/W | R self |

- **Planner backup (Deepa):** the `planner` role is granted to Deepa permanently; `backup_from/to` only drives alert routing, not access (simplest).
- **Procurement is read-only** (D19; C-013 decided). Procurement sends lead time, MOQ and Zoho mapping to Raghav, who enters them in Settings.
- **Screen gating** mirrors this table in middleware (each role sees only its screens/actions, §13). UI gating is convenience; RLS is the guard.
- **RLS implementation rules** (council):
  - `has_role()` / `is_owner()` are `security definer`, `stable`, with `set search_path = public`, so they don't recurse through `app_user`'s own RLS.
  - Every view is `with (security_invoker = true)`.
  - Every `security definer` RPC checks the caller's role itself as its first statement.
  - Owner-only changes (mode, holdout) and switching `rule_version.is_current` go through RPCs. `publish_rule_version` refuses parameters whose fields or types differ from the current version.
  - **People:** there are no direct writes to `app_user`. Admins use `admin_set_user` / `admin_add_user`, which refuse changes to the caller's own roles and never touch `is_owner`. `is_owner` is set only by the service role, per the RUNBOOK. This keeps an admin from making themselves owner or planner (D19).
  - No `security definer` function is executable by `anon` or `PUBLIC`.
  - `app_setting` Zoho domains are limited to Zoho's own hosts by a CHECK constraint.
  - Service-role writes (worker, cron) pass the actor explicitly to `change_log`; `auth.uid()` is null there.
- **Routes that call Zoho** (send, re-approve) run server-side with the writer, which RLS doesn't protect, so they **check the planner role in code** before doing anything.

### 3.3 Key database functions
supabase-js calls are not transactional, so **every multi-step write is one RPC**.
- `commit_upload(upload_id)`: `security definer`, `set statement_timeout = '120s'` (the `authenticated` default of ~8 s is too short for ~120k rows); staging rows are inserted beforehand in chunks of 5,000. One transaction. Rechecks hash uniqueness and as-of order, moves staging → facts, writes restatement `change_log` rows, rejects restatements older than 12 weeks, sets `status='committed'`, inserts a `run` row with `status='queued'`. Any error → rollback, nothing committed (partial set not committed).
- `engine_inputs(sku_ids text[], from_week text)`: returns one compact `jsonb` document per SKU (its distributor-week rows as arrays, stock snapshots, events), covering a **26-week look-back**. The "last k clean weeks" are searched inside that window; fewer than 8 found → queue. This avoids PostgREST's 1,000-row page limit. Batches are sized by **row count** (target ≤ 50k rows per call), not a fixed SKU count. It only selects and computes `net = shipped − returns`; **all cleaning stays in the pure engine**. A parity test checks it against the CSV loader on case data.
- `engine_stock(sku_ids, from, to)`: the same pattern for stock snapshots. Every snapshot in the look-back, including the current one, becomes stock history for the zero-stock exclusion. The current one is also on-hand. A run with no snapshot at all is blocked, not run with every SKU blocked.
- Implemented in milestone 2 as `claim_run` / `release_run`. The worker re-checks before writing that the run is still current, so a superseded run is never flipped back to ready. A run that fails 3 times is blocked and alerted instead of retried forever. One failing run never stops the cron from processing the others.
- `claim_run_step(run_id)`: `update run set locked_until = now() + interval '4 min' where id = $1 and (locked_until is null or locked_until < now()) returning *`. A row lease, so cron and the commit trigger never run the same step twice. Session advisory locks don't survive Supabase's transaction pooler.
- `set_mode(mode)`, `set_holdout(...)`, `publish_rule_version(params, reason)`: owner or planner checks inside; each writes `change_log`.
- `current_rules()`: returns the current `rule_version.params` (used by engine loader and the Instructions page ⚙ bindings, so both read the **same** source).

---

## 4. Weekly run (BUILD_PLAN §8) as a sequence

A run is a **persisted state machine**, so a Vercel timeout or a Zoho outage resumes instead of duplicating work.
- Each step is idempotent and claimed with the `run.locked_until` lease (§3.3).
- The worker route processes steps until it's done or has used ~80% of its time budget (`maxDuration` 300 s), then checkpoints.
- The commit Server Action starts the worker with Next.js `after()`. Postgres can't call HTTP without `pg_net`, so the database doesn't trigger it.
- Vercel Cron calls the worker every 5 min while a run is non-terminal, as a safety net. **This needs Vercel Pro:** Hobby cron runs at most once a day and isn't minute-precise, which would also break the Mon 10:00 and Tue 12:00 deadlines.
- A manual **Retry run** button for admins exists as well.

```
Priya        Upload UI      DB(commit_upload)   Run worker          Zoho (read)     Engine (pure)    Claude
  │ drop files   │                 │                 │                   │                │              │
  │─────────────►│ parse+validate  │                 │                   │                │              │
  │◄─ report ────│ (staging)       │                 │                   │                │              │
  │ Commit ─────►│────────────────►│ 1 tx: facts,    │                   │                │              │
  │              │                 │ run=queued ────►│                   │                │              │
  │              │                 │                 │ 1 zoho_read ─────►│ POs, receipts≥Mon, items,       │
  │              │                 │                 │◄──────────────────│ vendors, FR- drafts             │
  │              │                 │                 │  (retry/backoff; auth fail → BLOCKED + alert)       │
  │              │                 │                 │ 2 mapping check: unmapped SKU → blocked list       │
  │              │                 │                 │ 3 readback FR- drafts: issued/edited/deleted → log │
  │              │                 │                 │ 4–5 engine(inputs) ───────────────►│              │
  │              │                 │                 │◄──────── recommendations ──────────│              │
  │              │                 │                 │ 6 triage (pure, seeded spot-checks)│              │
  │              │                 │                 │ persist recs with TEMPLATE text    │              │
  │              │                 │                 │ status = ready ── queue visible ────────────────── │
  │              │                 │                 │ 7 llm: reasons + brief ───────────────────────────►│
  │              │                 │                 │   check numbers; pass → replace text; fail → keep  │
  │              │                 │                 │ status = done                                      │
```

Steps in detail:

| # | Step | Fails closed when | Output |
|---|---|---|---|
| 0 | **Preconditions** | No committed stock snapshot for this week's Sunday 23:59 IST; no sales for last complete week; snapshot not newer than last run; festival calendar missing next year (warn only) | `run.status=blocked` + alert to admin, uploader, planner |
| 1 | **Read Zoho** (§5) | Auth failure, outage after retries, rate limit exhausted | `run.zoho_read` (normalised) or `blocked` |
| 2 | **Mapping check** | SKU without active Zoho item or supplier without vendor | Those SKUs → `blocked` list (others continue; per-SKU fail-closed) |
| 3 | **Read back drafts** | — | `draft_po.status` → issued / edited (diff lines → procurement override) / deleted (procurement rejection) |
| 4 | **Clean history** (engine) | — | Net = shipped − returns; drop held distributor-weeks, inactive distributors from end week, new distributors' first 4 weeks (D2), zero-stock weeks where history exists (C-007). Aggregation per C-016 |
| 5 | **Rules** (engine) | < 8 clean weeks → queue | a12, a4, F (festival per C-004 / D1 blend), P (D5/D15), C, band, min_eff (D7), action, qty (C-005), flags, `assumed[]`, top-3 distributors (hidden in case-data mode) |
| 6 | **Triage** (engine) | — | D8 + C-001/C-002 + D16 cap + spot-checks C-008; holdout SKUs marked `holdout` and never drafted |
| 7 | **Claude** | Never fails the run | Reason per queue/spot-check card; weekly brief; template fallback on outage or mismatch |

The queue becomes visible at step 6 with template reasons; LLM text replaces template text as it is checked. **The LLM never blocks the run.**
Every card shows **"position as of {run.zoho_read.read_at}"**, so Raghav knows how old the Zoho data is on Tuesday.

### 4.1 Tuesday and procurement (C-015)

There is **one draft per supplier per week** (reference `FR-{isoWeek}-{supplierId}`), and we have **no update scope**. So a supplier's draft can be created only once, and only when everything for that supplier is settled.

**Line states** (per recommendation that orders something):

| State | Meaning | Goes into the supplier's draft? |
|---|---|---|
| `auto` | D8/C-002 auto-approved (incl. spot-checks once approved) | Yes |
| `queued` | Waiting for Raghav | — (blocks the supplier) |
| `approved` / `changed` | Raghav approved / changed qty | Yes (final qty) |
| `rejected` | Raghav rejected | No |
| `deadline_auto` | Tue 12:00 rule, non-perishable `C < min_eff`, 1× std | Yes |
| `rolled` | Tue 12:00 rule, everything else unreviewed | No, re-evaluated next Monday |
| `sent` | In a created draft (or a `shadow` row) | — |
| `held_changed` | A PO for this SKU was created or changed in Zoho after Monday's read (C-025) | No, re-evaluated next Monday |
| `blocked_pending` | The supplier had an un-issued draft from an earlier week **when this week's run read Zoho** (run step 3), or still has one at send | No, re-evaluated next Monday; alert. **Stays blocked even if the old draft is issued later this week**: this week's quantities were computed without it (drafts never count), so sending them would double-order (C-023) |

**Send to procurement** (planner button, and automatically at Tue 12:00):
1. **Role check in code** (planner), then **mode check**:
   `effectiveMode = (env APP_MODE === 'live' && app_mode.mode === 'live' && run.mode === 'live') ? 'live' : 'shadow'`.
   - If `APP_MODE` is unset or anything else, the result is `shadow` (fail closed).
   - `run.mode` is stamped when the run starts, so switching to live mid-week takes effect from **next Monday's run**. Half a week can never go live (C-023).
2. Choose suppliers with **no `queued` lines left** and no draft yet this week. Suppliers that still have queued lines wait, and the desk shows "N cards left for {supplier}".
3. Per supplier, in **live** mode:
   1. **Pending-draft block:** if run step 3 found an un-issued earlier draft for this supplier, its lines were already set to `blocked_pending` at run time. That block holds for the whole week, whatever happens to the old draft. Otherwise, re-check Zoho live: read the supplier's earlier FR- draft by `zoho_po_id` and list draft POs for that vendor. If one is a draft → all lines `blocked_pending`; status `skipped_pending`; message "issue or delete the pending draft FR-… first" on the desk and in the send result; email procurement and Raghav. Counted in the order-speed metric.
   2. Insert `draft_po(status='creating')`, then search Zoho for the reference **and** list draft POs for that vendor. Retry the search after 5 s, because search may lag behind a create.
      - Found → adopt its id (covers "response lost" and "crashed after POST").
      - Not found → `POST /purchaseorders` as a draft (covers "crashed between insert and POST").
   3. **Read the created PO back** by id. If its status isn't `draft` → abort the send, set run `blocked`, and alert the admin (ZO-14).
   4. Mark `created`, lines `sent`.
4. In **shadow** mode: no writer is constructed. `draft_po` rows are written with `mode='shadow'`, `status='shadow'`, lines `sent`.

**Decisions are conditional updates.** Approve, change and reject succeed only while the line is still `queued` (`update … where state = 'queued'`). A click that lands after the cron has acted gets "the Tuesday deadline already applied to this card". This also covers Raghav and Deepa clicking the same card at once.

**Tue 12:00 IST cron:** first apply D8 to every `queued` line (→ `deadline_auto` or `rolled`). An **unreviewed spot-check** keeps its auto-approved qty, because it was auto-eligible and is only queued as a sample; it is marked `deadline_auto` (C-023). Then run Send for **all** remaining suppliers. This includes lines Raghav approved but didn't send (C-015), so "approved, went home" still reaches procurement. Alert Deepa with the counts. All of this respects `effectiveMode`.

**Other crons:**
- **Daily:** drafts `created` more than 3 days ago → email procurement and Raghav; the card needs **Re-approve** (C-009, no Zoho write).
- **Mon 10:00:** no committed upload → alert the backup uploader, Raghav and Deepa.
- Every cron is idempotent: it checks an `alert` row or state before acting, so a double-fire is harmless.
- Vercel cron runs in UTC; IST has no DST, so 08:30 / 10:00 / Tue 12:00 IST = 03:00 / 04:30 / Tue 06:30 UTC.

**Late run (C-024):** if a run only becomes ready after Tue 12:00, the D8 deadline rule for that week applies at the **next 12:00 IST cron** after the run is ready (e.g. Wed 12:00). Deepa is alerted when the run becomes ready late.

**POs placed outside the system since Monday (C-025):** at Send, before creating a supplier's draft, list that vendor's POs modified since `run.zoho_read.read_at` (~1–3 calls).
- If any new or changed non-draft line touches a SKU being sent, that **line** is held (`held_changed`) with "position changed since Monday, re-review". It's re-evaluated next Monday; the rest of the supplier's lines are sent.
- There's no threshold: any change to that SKU holds the line.
- A held line doesn't stop the supplier's draft. Holding it can only order less, never double.

**Overdue open PO lines (C-026):** the engine flags `overdue_po` when open quantity sits on a PO line past its Zoho expected delivery date. P is unchanged; the card goes to the queue and shows "{n} units on PO lines overdue since {date}".

**Infeasible perishable cards** show both options from engine numbers. The stress test shows this card will be common while MOQ = std is assumed:
- "Order MOQ {moq}: cover after {x} weeks, above the {max}-week maximum";
- "Skip: about {d} days to stockout".

Raghav picks one; the change-qty path accepts MOQ.

### 4.2 Re-runs after a correction (C-015)
A corrected upload for the current week supersedes the run (`run.superseded_by`):
- **Before any draft is created that week:** re-run fully. A decision carries over only if that SKU's `action` and `qty` are unchanged; otherwise the card is re-opened with "data changed, re-review".
- **After drafts exist** for some suppliers: those suppliers' lines stay as sent; the correction affects them from next week. The desk says so. Other suppliers re-run as above.

---

## 5. Zoho integration and call budget

**Endpoints** (Inventory API v1, base from env, India DC default). All reads paginate at 200/page.

| Purpose | Call | Calls per run (400 SKUs, ~40 suppliers) |
|---|---|---|
| OAuth access token (1 h life, cached in `zoho_token_cache`, service role only) | `POST {accounts}/oauth/v2/token` | 0–2 |
| Non-draft, non-cancelled POs that may still have open lines (open, partially received; plus any modified since last Sunday) | `GET /purchaseorders` with status filters, paginated | 1–3 pages |
| PO line items (the list doesn't return lines) | `GET /purchaseorders/{id}` | ~60–120 (one per candidate PO) |
| Receipts dated ≥ Monday, **whatever the PO's status** | `GET /purchasereceives` by date + detail | ~10–40 |
| Items (mapping, unit check A4) | `GET /items` | 2–3 pages |
| Vendors | `GET /contacts?contact_type=vendor` | 1 page |
| Own drafts readback, **by stored `zoho_po_id`** (404 → deleted) | `GET /purchaseorders/{id}` | ≤ suppliers (~40) |
| **Read total** | | **~120–220** |
| Send: live re-check + changed-PO check (C-025) + search + create + read-back (live only, Tuesday) | `GET` ×4–6 + `POST` per supplier | ≤ 7 × suppliers ≈ 280 (separate invocation, has its own 300 budget) |

All filter parameter names (status values, reference search, receipt date range) and `organization_id` handling are **assumptions until verified in the test org** (ADR-0002). Real responses recorded there become the mock fixtures.

- **Budget enforcement:** a token-bucket limiter (≤ 90/min, headroom under 100), a per-run counter that aborts at 300 with `blocked: zoho_budget`, and `Retry-After`-aware exponential backoff (1 s → 32 s, 5 tries) on 429/5xx. 401 → one refresh, then fail closed.
- **If open-PO detail calls grow past budget:** cache PO details by `last_modified_time` in `run.zoho_read` and fetch only changed POs. Not needed for v1 at expected volumes.
- **Daily cap** depends on Freshroots' Zoho plan; to be read from the test org during week 1 and recorded in the ADR. Design assumes ≤ 600 calls/day including retries.
- **Refresh token:** exactly one, minted once by IT for the integration user, stored in env (`ZOHO_REFRESH_TOKEN`). Code never mints new refresh tokens (Zoho keeps max 20).
- **Position (D5/D15):**
  `P = SAP on-hand (Sun 23:59) + Σ lines max(0, ordered − received) over POs that are not draft and not cancelled + Σ receipt qty dated ≥ Monday of the run week`.
  - Drafts are excluded **by status only**. An FR- PO that procurement has issued is a real open PO and **is counted**. Excluding by reference would drop it and order the same units again.
  - Over-received lines clamp to 0.
  - Receipts are taken from `purchasereceives` by date, so a PO fully received on Monday (no longer "open") still adds its Monday receipt.
  - "Monday" is always the Monday of the **run's ISO week**, even for a mid-week re-run (§4.2).
- **Days to stockout** (queue sort only) = `SAP on-hand / F × 7`. It uses shelf stock only, not P, so in-transit stock doesn't hide urgency. The Tue 12:00 "stockout risk" test stays `C < min_eff`, as in D8.
- **Write-guard layers (§9, CLAUDE.md):**
  1. **Scopes:** READ + `purchaseorders.CREATE` only on the production token.
  2. **Separate tokens per environment:** preview and dev deployments get a refresh token minted with **read-only scopes**. Only the production environment holds the create-scoped token.
  3. **Code:** `ZohoDraftWriter` exposes only `createDraft()` and can't be constructed unless `effectiveMode === 'live'` (§4.1).
  4. **Payload:** the payload builder has no field for status.
  5. **Read-back check:** a created PO that isn't a draft aborts the send (ZO-14).
  6. **Tests:** the shadow-mode e2e asserts zero non-GET requests **to the Zoho API host**. The OAuth token POST to the accounts host is the only allowed POST.

  The week-1 test-org check (ADR-0002) is a **Milestone 1 exit blocker**.

---

### 5.1 Zoho failsafe (C-039)

When the Zoho read fails or Zoho isn't connected, the run blocks (fail closed). The owner may then run the week from files:
- `lib/filemode/parse.ts` (pure) validates an open-PO file and an optional receipts file: Zoho status names, known SKUs, sane numbers.
- `use_file_mode` (owner only, logged) stores the result as the run's `zoho_read` with `source: "file"` and moves the run to the engine step. The rules see the same PO lines and receipts a Zoho read would give.
- Send: `effectiveMode = live` + `run.source = file` gives mode `file`. It writes one `draft_po` per supplier per week (mode `file`), with no Zoho call. Procurement downloads the CSV sheet (`/review/sheet`) and confirms **placed** (`confirm_placed`, status `issued`).
- An earlier unplaced sheet holds its supplier, the file-mode form of the C-023 pending-draft rule.

---

## 6. Claude (lib/llm)

- **Model:** from `LLM_MODEL` env (default a current Sonnet-class model). Timeout 20 s per call, concurrency 5, no retries beyond 1.
- **Prompt input per card:** SKU id/name, action, qty, a12, a4, F, P, C, cover_after, band, flags, assumed fields, top-3 distributors as `D1..D3` with units and %. **No distributor names, no prices beyond what the card shows.**
- **Number checker:**
  - Strip known identifier patterns first: `SKU\d+`, `D[1-3]`, `\d{4}-W\d{2}`, `FR-…`.
  - Then extract every remaining numeric token (`1,200`, `6.1`, `25%`, `₹1.2L` → normalised).
  - Each token must match a value **in that card's allowlist**, built only from the engine payload: qty, a12, a4, F, P, C, cover_after, band ends, min_eff, lead time, uplift %, HD %, distributor units and %. The match is at the precision written (int, 1 dp or 2 dp, half-to-even per C-012).
  - There is no free pass for small numbers. Any unmatched number → template.
- **Qty is never read from LLM output.** The persisted `qty` comes only from the engine or a human decision. A test feeds an LLM reply saying "order 900" and asserts nothing changes.
- **Names:** inserted after the check by replacing `D1..D3` with names (hidden in case-data mode).
- **Brief:** same rules; input is aggregate numbers only (lines auto/queue, units, ₹ where costs exist, at-risk list, pilot vs manual stockout weeks, items needing Deepa).
- **Template fallback** is a deterministic sentence per action/flag combination; also used if `ANTHROPIC_API_KEY` is missing.

---

## 7. Upload (lib/upload)

- Files go to the private Storage bucket under the uploader's own folder, `uploads/{user id}/{batch}/` (avoids Vercel request-body limits; a storage policy enforces the folder). A server action then downloads, parses and validates them.
- **The validation report and staging rows are written by the server (service role) after it validates**, not with the uploader's JWT, so a report can't be forged through the API. The uploader commits with their own JWT through `commit_upload()`, which re-checks the report and every database-level rule (duplicate hash, as-of order, restatement window, foreign keys) in one transaction.
- Parse with all cells as **strings** (leading zeros kept), then strict numbers (`"1,200"` → 1200; `"12a"` → error).
- File type from headers; case-data header sets map per C-011.
- Validation (§7) produces a report of `error` (red, blocks), `confirm` (yellow, needs a click, e.g. ±40% volume), `warning` (info, e.g. out-of-footprint distributor). Each message links to the matching Instructions section.
- "No missing weeks": uploaded weeks must be contiguous and continue from the last committed week (restatements within 12 weeks excepted).
- **Stock as-of:**
  - **older** than the last run's as-of → rejected;
  - **equal** → treated as a correction of the current week (re-run per §4.2), and the report says so;
  - **newer** → a new week (C-023).
- **Backfill** (3 years, ~19M rows) does **not** go through the web upload. `scripts/replay` loads it with the same parser and validator, then `COPY`s it into a separate `backfill_sales` table. The weekly tables stay clean, and the web app's function limits don't apply.
- **Case-data mode** runs only in a **non-production Supabase project** (dev/demo), so case SKUs never mix with real data.

---

## 8. Outcomes

All outcome maths lives in one pure module, `lib/outcomes`, shared by the Outcomes page and the replay and applied identically to pilot and manual SKUs.
- **Stockout week** (C-031 B, replaces C-017): SKU-week with SAP on-hand under one unit at the Sunday snapshot, **or** at least one whole unit of demand lost that week (ordered_units > shipped, when supplied). Open POs and the forecast play no part, so the metric is fair to manual SKUs.
- **Low cover** (the old C-017, reported alongside as a warning): on-hand 0 or < 1 × raw clean a12. Lean perishable shelves dip below a week before each delivery by design, so this is not a stockout.
- **Pilot vs manual:** same weeks; holdout list fixed at go-live; reported as rates (stockout weeks per SKU-week; loss as % of net units, since ₹ is often unavailable) and per rule version (D12). The statistical method is **[PENDING C-019]**.
- **Order speed:** Monday upload commit → `draft_po.issued_at` (read back from Zoho), in working days. `skipped_pending` suppliers count as not issued.
- **Rejection rate:** unit-weighted, plus spot-check results; alarm < 5% and > 40%.
- **Shadow agreement** (weeks 8–11): measured from Raghav's approve/change/reject decisions on every card, used as the proxy for his manual plan (C-018).
- **Write-offs:** ⚠ **[PENDING C-014]**. The upload contract (§7) has **no write-off source**. Until decided, Outcomes shows write-offs as "not available".

---

## 9. Security

- Secrets only in Vercel env / `.env.local`: Zoho client secret + refresh token, Supabase service key, Anthropic key. `server-only` imports make accidental client bundling a build error.
- Logs redact `Authorization`, tokens and `refresh_token`; a unit test checks the redactor.
- Supabase Auth: email magic link or SSO later; `app_user` row required for any access (no row → no RLS rows).
- Cron routes require `CRON_SECRET`.

---

## 10. Monitoring and alerting

- Every run step writes `run.status` + timings; failures write `run.error` and an `alert` row → email (D19).
- Email is sent through **Resend** (C-027) from `lib/alerts`, with `RESEND_API_KEY` server-side only. Supabase Auth's mailer is used only for login links.
- Alerts: upload missed (Mon 10:00), run ready late (C-024), run blocked, Zoho auth failure, Tue deadline applied, draft > 3 days, rejection-rate alarm, LLM fallback rate > 50% in a run (info to IT).
- Vercel logs for traces; Supabase logs for DB.

---

## 11. Trade-offs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Run execution | DB state machine + row lease + worker route + cron safety net (Vercel Pro) | Queue service (Inngest, QStash), or a manual retry only | No new vendor; weekly volume is tiny; idempotent steps make resume trivial; a stuck run must not wait for someone to notice (fail closed + alert) |
| Access-token cache | DB table, service role only | Memory only | Serverless invocations would each mint a token and hit Zoho's token-mint limit (limit to be verified in week 1) |
| Where rules run | TypeScript pure module, rows loaded in SKU batches | SQL views / stored procs | Testable with Vitest, reused by replay, readable by a reviewer |
| Restatements | Upsert + change_log | Bitemporal fact table | 12-week window and low volume; simpler queries |
| Zoho PO detail | Fetch per open PO each run | Incremental cache | Fits budget at expected volume; cache is a documented next step |
| Roles | 5 roles + `is_owner` flag | Separate "owner" role | Keeps D19's five roles while letting only Deepa switch mode/holdout |

## 12. What to revisit as it grows
- Open POs > ~200 → incremental PO cache (§5).
- Multi-warehouse (deferred §14) → `location_id` on `stock_snapshot` and position.
- SAP API (deferred) → replace `lib/upload` input adapter only; the staging/commit contract stays.
- Replay at 19M rows → pre-aggregate to SKU-distributor-week once into a replay table.
