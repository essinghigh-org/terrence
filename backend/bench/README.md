# Benchmarks

Run from the backend dir: `bun run bench/<file>.ts [--json out.json]`
Run from the frontend dir: `bun run bench/frontend.bench.ts [--json out.json]`

The harness (`bench/harness.ts`) is a tiny warmup + median/p95 runner: this Bun
build has no `bun bench` subcommand. All files are standalone; the DB and HTTP
benches boot their own temp database.

## Files

| File | What it measures |
|---|---|
| `db-queries.ts` | The three hottest runs-table queries (queue scan, workspace run list, calendar range) at 60k rows, before/after index creation |
| `pure.bench.ts` | Security headers, url-safety, plan-json counts, notification rendering, runResource serialization, request helpers |
| `http-routes.bench.ts` | Real end-to-end HTTP: boot the app against a temp DB, time authed/unauth requests |
| `frontend/bench/frontend.bench.ts` | cn() patterns, ChangeCalendar sort |

## Results (2026-08-15)

### DB queries (60k runs, 200 workspaces) — the headline win

| Query | Before (no index) | After (indexed) | Speedup |
|---|---|---|---|
| pending queue scan (pollWorkerQueue) | 4.05 ms | 0.02 ms | ~200x |
| workspace run list | 3.65 ms | 0.10 ms | ~36x |
| change-calendar confirmed range | 10.49 ms | 0.62 ms | ~17x |

Indexes added: `runs(workspace_id, status, created_at)`,
`runs(status, created_at)`, `configuration_versions(workspace_id, created_at)`,
`workspaces(org_id)` (both schemas + idempotent boot-time creation).

### HTTP end-to-end (temp DB, real app)

| Request | median |
|---|---|
| GET /api/v2/ping (unauth) | 0.084 ms |
| GET /readyz | 0.344 ms |
| GET workspace runs list (50/page, authed) | 3.94 ms |

### Pure functions

Security headers ~0.002 ms/response (CSP memoized; was rebuilt per response),
url-safety corpus 0.023 ms/24 hosts, planJsonResourceCounts(1000) 0.073 ms,
runResource 0.008 ms/run, signedApiURL 0.012 ms.

### Frontend

cn() ~0.75 us/call (twMerge floor), calendar sort 2000 entries 0.077 ms.

## Dead ends (measured, not assumed)

- **cn() memoization reverted**: a bounded LRU keyed on serialized inputs was
  9-17% SLOWER on realistic conditional-heavy call patterns. Key building +
  Map lookups cost ~0.23 us/call while twMerge itself costs ~0.6 us; the win
  only appeared on pure-string repeated calls. Documented at the cn() call
  site in `frontend/src/lib/utils.ts`.
- runResource, pagination, privateHostReason, notification rendering were all
  measured at microseconds and left untouched.
