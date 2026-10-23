# ADR-0005: Shadow mode by default; only Deepa can switch to live

**Status:** Accepted
**Date:** 23 Oct 2026
**Deciders:** Deepa Nair (the only person who can switch), Utkarsh

## Context
- In weeks 8–11 the system runs alongside Raghav's manual plan, to measure agreement, overrides and speed.
- During that time it must not create real orders (D17).
- A single mis-click or bug must not let it write to Zoho.

## Decision
- `app_mode.mode` defaults to `shadow`. Only an admin with `is_owner` (Deepa) can change it. This is enforced by RLS and logged in `change_log`.
- Each run records the mode it ran in.
- In shadow mode, "Send to procurement" records the decisions and writes `draft_po` rows with `status='shadow'`. The Zoho writer refuses to be constructed, so no write request can leave the server.
- Switching to live takes effect from the next send action, never retroactively.
- `APP_MODE` in the environment is a deployment-level ceiling. The effective mode is `live` only if **both** `APP_MODE === 'live'` and the database says `live`. Unset or any other value means shadow (fail closed). This protects preview and dev deployments.
- **The real guard is the token:** preview and dev deployments hold a refresh token with read-only scopes, so a code bug there still can't write. Only production holds the create-scoped token.
- The **Tue 12:00 automatic send** (C-015) goes through the same `effectiveMode` check. In shadow mode it writes only `shadow` rows.
- `mode` lives in its own `app_mode` table, changed only via the `set_mode()` RPC (owner check inside). RLS can't restrict a single column.

## Options considered

### Option A: Database mode + environment ceiling + writer guard (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | None |
| Scalability | n/a |
| Team familiarity | High |

**Pros:** three independent locks; previews and dev can never write; the switch is auditable.
**Cons:** go-live needs two settings changed (documented in the RUNBOOK).

### Option B: A separate Zoho org for shadow
**Pros:** exercises the real write path.
**Cons:** its data differs from the real org, so the stock position would be wrong. Rejected for shadow; the test org is still used for development.

## Consequences
- **Easier:** safe shadow weeks. An e2e test asserts zero non-GET Zoho calls in shadow mode.
- **Harder:** going live needs both the environment ceiling raised and Deepa's switch.
- **Revisit:** none expected.

## Action items
1. [ ] RLS policy and `change_log` trigger on `app_setting`.
2. [ ] `getDraftWriter(mode)` guard and the e2e "no writes in shadow" test.
3. [ ] RUNBOOK section "Switching shadow → live".
