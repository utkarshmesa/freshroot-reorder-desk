# ADR-0001: SAP data arrives as CSV/XLSX uploads, not an integration

**Status:** Accepted (locked in BUILD_PLAN v1.2, DECISION_LOG §5)
**Date:** 23 Oct 2026
**Deciders:** Utkarsh (build lead), Deepa Nair (owner), IT SAP admin

## Context
- SAP is Freshroots' system of record for sales and stock. The 3-person IT team already runs it.
- Budget is ₹15L and 90 days. There is no AI or data-engineering team.
- Priya already exports SAP data as structured files every month.
- The loop needs **weekly** data, and must fail closed when data is missing or stale.

## Decision
Priya uploads two files every Monday through the Upload screen:
- `sales_weekly`;
- `stock_snapshot` as at Sunday 23:59 IST.

Master files are uploaded only when they change. Files are parsed with every cell as a string, validated (BUILD_PLAN §7) and committed all-or-nothing in one database transaction (`commit_upload`). An SAP API connection is deferred (§14).

## Options considered

### Option A: CSV/XLSX upload with strict validation (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low. A parser, a validator and one transactional commit. |
| Cost | Near zero. No SAP licences or middleware. |
| Scalability | ~120k rows/week fits comfortably. Files go to Storage first, which avoids request-size limits. |
| Team familiarity | High. Priya already exports these files. |

**Pros:** ships in weeks 1–2; no change to SAP; every input is auditable (file hash, report, uploader).
**Cons:** a manual step every week (accepted risk §15); Excel can corrupt IDs (mitigated by string parsing and the INSTRUCTIONS guidance).

### Option B: SAP API (OData/RFC) or scheduled extract
| Dimension | Assessment |
|---|---|
| Complexity | High. Auth, network access to SAP, and change requests to the SAP team. |
| Cost | Likely licence and consultant costs. |
| Scalability | Good. |
| Team familiarity | Low for app code; competes with IT's SAP workload. |

**Pros:** no manual step.
**Cons:** blows the timeline and budget; puts a fragile dependency on the critical path before the day-45 gate proves the rules work.

## Trade-off analysis
The bottleneck today is Raghav's manual data work, not the act of exporting. A 5-minute upload, followed by an automatic run, cuts the exposure window from about 10 weeks to about 4. The extra gain from an integration is small until the loop is proven.

## Consequences
- **Easier:** a fast build. The input adapter (`lib/upload`) can later be replaced by an API adapter behind the same staging/commit contract.
- **Harder:** upload discipline. Covered by the Mon 10:00 alert, a backup uploader and fail-closed runs.
- **Revisit:** after go-live, if missed uploads exceed 1 in 8 weeks.

## Action items
1. [ ] Parser and validator with fixtures for every §13 upload test.
2. [ ] `commit_upload` RPC (single transaction).
3. [ ] Mon 10:00 IST missed-upload alert.
