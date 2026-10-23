# CLAUDE.md: Freshroots Reorder Desk

You are building the **Freshroots Replenishment Loop** (the "Reorder Desk") for a MESA Term 2 case study. Read this file first, every session.

## Source of truth (read in this order)
1. `docs/BUILD_PLAN.md`: the **locked** plan (v1.2). Decisions D1–D20, data model, upload contract, run pipeline, Zoho rules, screens, milestones, acceptance tests. **Do not change scope without a change note** (see Working rules).
2. `docs/INSTRUCTIONS.md`: content for the in-app Instructions screen. Values marked ⚙ must be bound live to Settings.
3. `docs/CASE_CONTEXT.md`: the business problem, people and constraints.
4. `docs/DECISION_LOG.md`: why the plan looks like this (nine checks, council, stress tests). Read it before proposing alternatives.
5. `docs/component-map-v3.png`: the architecture at a glance.
6. `data/case/*.csv`: the case data. `data/reference/expected_2026-W43.json`: the outputs the rules engine **must** reproduce on that data.
7. `prototype/reorder-desk.html`: UX reference for the review desk only (not production code).

## What success means
Pilot SKUs get **fewer stockout weeks and lower perishable write-offs than SKUs kept on manual planning**, and approved orders are issued in Zoho within 2 working days. Activity metrics (cards shown, AI text produced) are **not** success.

## Non-negotiable guardrails
- **Code decides quantities. Claude (LLM) only explains** (reason per queue card + weekly brief). Every number in LLM text is checked against engine output; on mismatch or outage, use the template text. The LLM never blocks a run.
- **Zoho permissions:** read POs, receipts, items, contacts and settings; **create** purchase orders (drafts) only. **No update/delete scopes.** Never issue, edit or delete a PO.
- **Only one un-issued system draft per supplier at a time.** Drafts never count as stock. References look like `FR-{isoWeek}-{supplierId}`; check a reference exists before creating.
- **Shadow mode is the default:** no Zoho writes until Deepa switches to Live.
- **Stock position** = SAP on-hand at **Sunday 23:59** + open Zoho PO qty (issued, not cancelled, ordered − received) + Zoho receipts dated Monday or later.
- **Fail closed per SKU.** A missing file, stale data or a Zoho/auth failure blocks the whole run and alerts.
- **No SAP integration.** SAP data arrives only as CSV/XLSX uploads.
- **Secrets:** Zoho refresh token, Supabase service key and Anthropic key are server-side only. Never in client code, logs or commits. Use `.env.local` (git-ignored); `.env.example` lists the names.
- **Privacy:** prompts to Claude contain numbers and anonymised distributor codes (D1, D2…). Names are inserted afterwards.
- **ISO weeks everywhere.** 2026 has a **W53**; test W52 → W53 → 2027-W01.

## Stack
- Next.js (App Router, TypeScript, strict) on Vercel.
- Supabase: Postgres, Auth, Storage, RLS on every table.
- Vercel Cron for reminders and escalations, in IST.
- Anthropic API (Claude) for reasons and the brief.
- Zoho Inventory API: India DC by default (`accounts.zoho.in`, `www.zohoapis.in`), configurable.
- Tests: Vitest (unit, rules engine), Playwright (end-to-end).
- One language (TypeScript). The rules engine is a **pure module** with no I/O so it can be unit-tested and reused by the replay script.

Suggested layout:
```
app/            # routes: upload, review, settings, outcomes, instructions
lib/engine/     # pure rules engine (clean history, position, cover, actions, qty, triage)
lib/zoho/       # server-only Zoho client (OAuth refresh, retries, idempotent drafts)
lib/upload/     # parsing + validation (CSV/XLSX, header detection, ISO weeks)
lib/llm/        # prompt builders, number checker, template fallback
scripts/replay/ # one-off 3-year replay for the day-45 gate
supabase/       # migrations, seed (case data), RLS policies
tests/          # unit + e2e; fixtures for every acceptance test in BUILD_PLAN §13
```

## Working rules
- **Build in milestone order** (BUILD_PLAN §12). Finish each milestone's exit check before starting the next.
- **Rules-engine tests come first.** `expected_2026-W43.json` must pass before any UI work on the review desk.
- Every acceptance test in BUILD_PLAN §13 becomes an automated test.
- **Scope changes:**
  - Want to add or change scope? First run the **nine-checks-build-decision** skill on it.
  - Write a short change note in `docs/CHANGES.md` (what, why, which decision it affects).
  - Ask the user before implementing.
  - Deferred items (§14) stay deferred.
- **Ambiguity:** prefer the simplest option that serves the four jobs: **see** (count every unit once), **decide** (Raghav's rules), **keep a person** where mistakes are costly, **prove** (pilot vs manual).
- Keep `docs/INSTRUCTIONS.md` in sync when behaviour or defaults change. It's what users read instead of asking us.
- Don't invent business numbers. Use the plan's defaults (D18) and show "assumed" in the UI.
- Commit small, with clear messages. Never commit secrets or real Freshroots data beyond `data/case/`.

## Commands
Local setup: Docker running, then `npm install`, `npx supabase start` (ports 563xx so other local Supabase projects keep 543xx/553xx), copy keys from `npx supabase status` into `.env.local` (see `.env.example`; set `CASE_DATA_MODE=true` locally only).
- `npm run dev`: app on http://localhost:3000 (local test users and password: `scripts/seed/users.ts`, local only)
- `npm test`: unit tests (Vitest; pure modules)
- `npm run test:integration`: database + RLS tests; **resets the local database** first
- `npm run test:e2e`: Playwright (reuses a running dev server, or builds and starts one)
- `npm run lint` / `npm run typecheck`
- `npx supabase db reset`: apply migrations + seed (rules v1, reason codes, local users). Case data is loaded through the Upload screen in case-data mode.
- `node --experimental-strip-types scripts/seed/build-seed.ts`: regenerate `supabase/seed.sql` after changing `lib/rules/defaults.ts` or the local users
- `npm run replay`: day-45 replay (scripts/replay, milestone 4)
