# ADR-0002: Direct Zoho Inventory API with read + create-draft scopes only

**Status:** Accepted, **pending week-1 verification** in the Zoho test org (see "Verification")
**Date:** 23 Oct 2026
**Deciders:** Utkarsh, IT owner, Procurement head

## Context
- Purchase orders live in Zoho Inventory.
- The stock position (D5) needs open PO quantities and receipts.
- Approved orders must reach procurement as drafts.
- The ₹22L order that became a ₹9L write-off shows the cost when nothing stops an order once it's approved.
- Approver and issuer must be different people (D19).

## Decision
- Call the Zoho Inventory REST API server-side as a dedicated integration user, using one refresh token.
- Scopes: `purchaseorders.READ`, `purchaseorders.CREATE`, `purchasereceives.READ`, `items.READ`, `contacts.READ`, `settings.READ`. **No UPDATE or DELETE.**
- Code guard: `ZohoDraftWriter` exposes only `createDraft()`, cannot be constructed in shadow mode, and never sends an issued status.
- Idempotency: reference `FR-{isoWeek}-{supplierId}`, a unique database row inserted before the call, and a search by reference before create.
- Only one un-issued system draft per supplier at a time (D11).

## Options considered

### Option A: Direct API, least-privilege scopes (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium. OAuth refresh, pagination, rate limiting. |
| Cost | Inside Zoho plan limits. Budget ≤300 calls per run. |
| Scalability | Fine at ~40 suppliers and ~100 open POs. |
| Team familiarity | Medium. IT knows Zoho as users. |

**Pros:** live open-PO data (no reconciliation file); the system can't issue or edit by design; procurement keeps its workflow.
**Cons:** depends on Zoho's availability (fails closed, with Raghav's manual fallback); the 20-refresh-token limit must be respected.

### Option B: Zoho CSV export/import
**Pros:** no API work.
**Cons:** another manual weekly step, and stale open POs lead back to duplicate orders (stress test, DECISION_LOG §4). Rejected by the user (DECISION_LOG §5).

### Option C: Full-scope API (create, update, issue)
**Pros:** could issue POs automatically.
**Cons:** removes the human gate, so one bug could order across every supplier. Rejected.

## Trade-off analysis
Read access is what makes the position correct. CREATE is what turns a decision into a PO in hours instead of weeks. Anything beyond that adds risk without serving the four jobs.

## Additional guards (added after the council)
- **Exclude drafts by status only.** An issued `FR-` PO is real stock on order and is counted.
- **Read back by the stored `zoho_po_id`.** Procurement may edit the reference.
- **Re-check Zoho live** for the supplier's pending draft immediately before creating a new one.
- **Read back every created PO.** If it isn't a draft, abort and alert (ZO-14).
- **Non-production environments get a read-only-scope refresh token.** Only production holds the create-scoped token. One extra token stays far below Zoho's 20-per-user limit.

## Verification (week-1 must-do; **Milestone 1 exit blocker**)

> **Status (24 Oct 2026):** not run yet. The Zoho account couldn't create an Inventory organisation (Zoho error 6063); deferred (C-030a). Self Client and refresh token are ready in `.env.zoho-test`.
In the test org, with exactly this scope set:
1. create a PO as a draft;
2. attempt to mark it issued via the status endpoint, update it, and delete it;
3. attempt to create a PO with an issued status in the payload.

Record each response below, along with the plan's daily API cap. **If any write beyond creating a draft succeeds**, keep the code guard as the primary control, add a test proving the payload builder can't express it, and flag it to Utkarsh as a risk.

| Check | Result |
|---|---|
| Create draft | _tbd_ |
| Mark issued via status endpoint | _tbd_ |
| Update PO | _tbd_ |
| Delete PO | _tbd_ |
| Create with issued status in payload | _tbd_ |
| Daily API cap for the plan | _tbd_ |
| Access-token mint limit (per 10 min) | _tbd_ |
| PO status values and list filters (open, partially received, draft, cancelled) | _tbd_ |
| Reference search parameter and its lag after a create | _tbd_ |
| Purchase-receive date filter | _tbd_ |
| Read-only-scope token: create is refused | _tbd_ |

Record the raw responses under `tests/fixtures/zoho/recorded/`. They become the mock fixtures.

## Consequences
- **Easier:** an honest split between code guards and process guards (D11); a reliable D5 position.
- **Harder:** the 3-day "don't issue old drafts" rule is policy, not code.
- **Revisit:** if Zoho adds finer-grained scopes, or Freshroots' org is in another data centre (configurable).

## Action items
1. [ ] Test org mirroring the 15 case SKUs and 4 suppliers, plus the integration user.
2. [ ] Run the verification checks and fill in the table.
3. [ ] Mock Zoho server for unit and integration tests until credentials arrive.
