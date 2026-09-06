# Review remediation status

Status is tracked against the current checkout: 21 implemented findings, 18 partial remediations, and 101 pending entries. Pending entries have not yet been validated.

| ID | Priority | Issue | Status | Finding |
|---|---|---|---|---|
| SEC-01 | P0 | #684 | Implemented: allowlisted public plan projection; masks missing representations closed. Unit/API/MCP tests; historical artifacts projected on read. | The sanitized plan still contains sensitive top-level input variables |
| SEC-02 | P0 | #685 | Implemented: both run state-link endpoints require state-read; grant/revoke custom-team regression passes. | Two run endpoints mint state-download capabilities without checking state-read permission |
| SEC-03 | P0 | #686 | Implemented: organization-scoped SSE visibility and reject missing workspace IDs; cross-org owner/member regression passes. | One unrestricted organization widens SSE visibility inside another organization |
| SEC-04 | P0 | #687 | Core fix implemented: public plan input and versioned cache key. Historical provider exposure and apply-log minimization remain to assess. | The AI explainer reads the raw plan despite a sanitized-input comment |
| COR-01 | P0 | #688 | Implemented: rollback and recovery rewrite serial consistently and rebuild outputs; lossless large numeric literals. SQLite and PostgreSQL regressions pass; both CLI read/plan checks pass; crash matrix pending. | Rollback and recovery can make the state row serial disagree with the actual state bytes |
| COR-02 | P0 | #689 | Implemented: inline state uses strict shared v4 validator; reservation serial must be nonnegative safe integer. Updated invalid legacy test fixtures. | Inline state creation accepts JSON that is not a valid Terraform state, and pending serials are under-validated |
| COR-03 | P0 | #690 | Core fix implemented: reserved checksum/lineage/serial, one-hour expiry and lock identity; transactional workspace fence and output commit; exact-byte SHA-256 retry comparison. SQLite and PostgreSQL regressions pass. Real CLI/crash-injection matrix remains. | Deferred state upload is not bound to the reservation’s checksum, serial and lineage |
| COR-05 | P0 | #691 | Local worker/assessment and modern agent fixed: sensitivity-independent run overlay, priority inputs win; private local var-files and no priority argv. Legacy-agent precedence still needs end-to-end validation. | Marking a run variable sensitive changes which value wins |
| COR-09 | P0 | #692 | Implemented: malformed pipes fall back to paragraph; all prefixes of streamed table fixture render. | A malformed Markdown table line causes an infinite parser loop |
| COR-12 | P0 | #693 | Core fix implemented: refuse nonfinal runs, active local processes/cgroups/escalation, and queued/claimed agent jobs. Missing worker ownership and distributed lifecycle matrix remains. | Deleting an active run removes its record without stopping its worker process |
| COMP-11 | P0 | #695 | Core matrix added: 10 principals across 5 read surfaces and 3 object scopes; denied mutations/admin, grant/revoke HTTP+MCP, suspension/expiry/browser-family checks. Found and fixed MCP suspension bypass by reusing shared auth. Full endpoint-policy/export/cache matrix remains. | Add negative permission contracts for custom roles and every credential type |
| COMP-05 | P0 after state fixes | #694 | Partial: Terraform 1.15.9 and OpenTofu 1.12.1 local pull/show/refresh-disabled plan verify API inline/deferred uploads, rollback, recovery, digests, indexed outputs and stale-write rejection on SQLite and PostgreSQL. Remote CLI writes and crash injection remain. | Add a real CLI state-integrity suite around upload, rollback and recovery |
| SEC-05 | P1 | #696 | Implemented: every browser token has refresh family; family revocation deletes grace tokens and auth checks family liveness. Concurrency/logout regression passes. | Refresh-token grace paths create access tokens that family revocation cannot find |
| SEC-06 | P1 | #697 | Implemented: sensitive new run inputs encrypted before insertion; local and both agent transports decrypt for execution; API omits ciphertext. Rerunnable backfill rehearsed twice on isolated SQLite and PostgreSQL. Production backfill not run. | Sensitive run-specific variables are stored as plaintext JSON |
| SEC-07 | P1 | #698 | Implemented: replaced blanket encryption statement with artifact-specific storage/backup table. | Correct the at-rest encryption claim and classify every artifact |
| SEC-08 | P1 | #699 | Core lifecycle implemented: signed path capabilities bind run/phase/token version/expiry, default 48h for legacy CLI streams; authorized fresh links, admin revoke action/audit, soft-delete disablement, cache/referrer policies. Short-window automatic CLI renewal remains unsupported; membership removal does not immediately revoke issued bearer links. | Run-log capability URLs have no independent expiry or revocation lifecycle |
| SEC-09 | P1 | #700 | Implemented: plan permission for creation; author or workspace admin for deletion. Negative team tests pass. | Run-read permission currently allows comment creation and deletion of other authors’ comments |
| SEC-10 | P1 | #701 | Partial: invalid settings fail; docs explicitly describe TCP-only deny. Full UDP/socket isolation remains. | “Deny network” is TCP-only, and an invalid setting silently becomes allow |
| SEC-11 | P1 | #702 | Implemented: shared deletion removes raw and all four agent side artifacts even if raw is missing; regression passes. | Run deletion and retention leave agent-produced side artifacts behind |
| COR-04 | P1 | #703 | Core lifecycle implemented: obsolete pending reservations release their unique serial on unlock, discard or next creation; atomic audit tombstones preserve reasons. Old PUTs rejected, committed state retained. SQLite/PG tests pass; explicit crash-injection and legacy lock reconstruction remain. | Make abandoned state-upload reservations a complete, tested lifecycle |
| COR-06 | P1 | #704 | Core fix implemented: shared comparator for scope/ownership/priority and Unicode code-point ties; API/execution/modern-agent regressions pass. Full rename/project-move/provider matrix remains. | Variable-set precedence uses the wrong priority ordering and a locale-dependent tie-break |
| COR-07 | P1 | #705 | Implemented: seed inherited environment once and retain workspace/run/priority ordering across local phases and assessment. | The run environment reseeds inherited defaults and overwrites workspace values |
| COR-08 | P1 | #706 | Interim fix implemented: lexical scanning skips comments, strings, heredocs and nested metadata; regression corpus passes. Full HCL parser/CLI comparison and explicit partial diagnostics remain. | The HCL variable scanner treats comments and nested attributes as declarations |
| COR-10 | P1 | #707 | Implemented: data router with one shared supported blocker and Stay/Discard dialog; removed global history patch. Dirty sections register through effects; beforeunload retained. Unit Back/Forward/save/failure/query tests and real browser comment preservation pass. | The dirty-form guard does not cover browser Back and Forward |
| COR-11 | P1 | #708 | Implemented: workspace 404 recovery restricted to GET/HEAD; mutation regression passes. | The workspace-404 retry path can replay mutating API requests |
| COR-13 | P1 | #709 | Implemented: validate JSON before private temporary write and atomic rename; rejected upload preserves prior artifact. Also fixed object-to-string agent body handling. | Agent side-artifact publication can replace a good artifact with an incomplete or invalid file |
| COR-14 | P1 | #710 | Implemented: archives and bounded live reads preserve latest 10000 rows in chronological order; byte-slice regression passes. | Large log archives preserve the beginning but can discard the actual failure tail |
| COR-15 | P1 | #711 | Implemented: only missing archives return empty; corrupt/unreadable archives throw. Regression passes. | Corrupt or unreadable log archives are reported as an empty log |
| COMP-01 | P1 | #712 | Implemented: isolated PostgreSQL targets and explicit cleanup, unavailable-target rejection, verified backend/security profiles, create/import/update/no-op/destroy on SQLite and PostgreSQL with both CLIs, and real production-sandbox provider execution. Fixed fresh-PG bootstrap ordering. CI captures named successful lifecycle evidence. | The provider end-to-end harness forces SQLite and disables the run sandbox |
| COMP-02 | P1 | #713 | Implemented: Four checksum-verified floor/current CLI pins run provider and remote plan/approval/apply/state/no-change journeys. Generated report requires all four successful artifacts; scheduled canaries retain pins and create a review issue on failure. CI wiring validated locally, not yet executed on GitHub. | Turn the supported Terraform/OpenTofu versions into an executable compatibility matrix |
| COMP-03 | P1 | #714 | Partial: first-stage fixture resources now require two unchanged plans and empty state after destroy. Variable-set descriptions set/clear/restore and team minimal-config import converge with both CLIs on SQLite/PostgreSQL; required sandbox verified. Fixed ignored team/OAuth flags, absent retention identifiers and membership read endpoint, plus empty agent-pool handling and conflicting fixture ownership. Named JSON artifacts separate measured claims from inventory; remaining family imports/null/permission cases are pending. | Measure provider compatibility by repeated lifecycle behavior, not just schema coverage |
| COMP-04 | P1 | #715 | Partial: Real CLI init, remote plan, interactive approval/apply, state pull and unchanged-plan exit codes now run on all four pins. Saved plans, reviewed-run/input-state identity, refresh-only, cancellation/reconnect and stale-plan transcripts remain open. | Test actual CLI command semantics, especially saved plans and remote approval |
| COMP-06 | P1 | #716 | Partial: explicit rejection policy for API, agent completion and shared worker state writes; real encrypted OpenTofu fixture proves correct/missing/wrong keys and migration, unchanged current state, retained recovery bytes and continued CLI reads/plans. Legacy encrypted state has unavailable structured-view flags and API/MCP errors. Remaining: real encrypted remote CLI push, full worker/agent failure journeys, preflight of encryption configuration, and legacy Explorer count semantics. | Define OpenTofu encrypted-state support explicitly instead of relying on generic JSON acceptance |
| COMP-07 | P1 | #717 | Partial: Disposable trusted TLS proxy covers real CLI discovery, non-default ports and signed external origins. Fixed IPv4-mapped peer trust; trusted/untrusted and malformed CIDR regressions pass. Browser-assisted login, negative CA cases, interrupted flows and subpath guidance remain open. | Exercise discovery and login through realistic reverse proxies and private certificate authorities |
| COMP-08 | P1 | #718 | Pending | Create a typed variable-transport corpus shared by local and agent execution |
| COMP-09 | P1 | #719 | Partial: public projection version 1 preserves absent versus null values and ordered actions; unknown actions become an explicit unsupported marker. Shared UI classification retains forget operations, counts actual deletes correctly, and exposes unsupported operations in lists and summaries. Remaining: real engine fixture corpus, full format adapters, unknown extension coverage and approval-summary parity. | Version the plan projection and test unknown, moved, imported and action-only changes |
| COMP-10 | P1 | #720 | Pending | Test registry protocols end to end, including private hosts and checksum behavior |
| COMP-12 | P1 | #721 | Pending | Standardize retry, idempotency and status-code semantics for remote clients |
| COMP-15 | P1 | #722 | Pending | Treat the agent protocol as a separately versioned compatibility product |
| UI-01 | P1 | #723 | Pending | Make the workspace overview answer “what is this, is it healthy, and what do I do next?” |
| UI-02 | P1 | #724 | Pending | Make the run page a decision surface, with one stable primary action |
| UI-03 | P1 | #725 | Pending | Separate run stage, outcome and waiting reason instead of compressing them into one badge |
| UI-04 | P1 | #726 | Pending | Turn the plan into a navigable change review, not an expandable JSON dump |
| UI-06 | P1 | #727 | Pending | Make logs behave like an operational log viewer |
| UI-07 | P1 | #728 | Pending | Make onboarding a live readiness checklist, not static instructions |
| UI-09 | P1 | #729 | Pending | Expose variable precedence in the table rather than hiding the explanation in hover text |
| UI-11 | P1 | #730 | Pending | Simplify token creation with presets and an exact permission summary |
| UI-13 | P1 | #731 | Pending | Make organization and workspace context persistent and hard to confuse |
| UI-16 | P1 | #732 | Pending | Use distinct empty, loading, filtered-empty, forbidden and failed states |
| UI-17 | P1 | #733 | Pending | Give errors a next action, a stable code and a copyable diagnostic reference |
| UI-18 | P1 | #734 | Partial: removed misleading safe-download wording, named raw downloads and secret exposure, preserved exact response bytes (including large JSON numbers), and disabled unsupported encrypted recovery/inspection with an explanation. Recovery provenance/next-plan confirmation and full rollback/recovery action presentation remain open. | Label raw state downloads honestly and make recovery actions unmistakable |
| UI-20 | P1 | #735 | Pending | Explain disabled actions using actual capability decisions |
| UI-21 | P1 | #736 | Pending | Use different confirmation patterns for cancel, force-cancel, discard and delete |
| UI-24 | P1 | #737 | Pending | Expose connection and synchronization state without alarming the user unnecessarily |
| UI-28 | P1 | #738 | Pending | Preserve the intended destination consistently through session expiry |
| UI-32 | P1 | #739 | Pending | Make agent-pool health explain why a run is waiting |
| UI-33 | P1 | #740 | Pending | Make database migration and maintenance feel reversible and observable |
| ENG-01 | P1 | #741 | Pending | Split the worker around lifecycle ownership, not arbitrary file size |
| ENG-02 | P1 | #742 | Pending | Break up the generic utilities module by trust boundary |
| ENG-03 | P1 | #743 | Pending | Move multi-step mutations out of route handlers into transactional domain commands |
| ENG-04 | P1 | #744 | Pending | Replace permissive persisted JSON casts with versioned schemas and migrations |
| ENG-06 | P1 | #745 | Pending | Stop fetching every workspace page before the user can use the list |
| ENG-07 | P1 | #746 | Pending | Materialize state summaries instead of repeatedly decrypting and parsing large payloads on list requests |
| ENG-08 | P1 | #747 | Pending | Move log compression and decompression off latency-sensitive request paths |
| ENG-09 | P1 | #748 | Pending | Centralize archive inspection and subprocess supervision |
| ENG-12 | P1 | #749 | Implemented: database deployment topology states one active control plane, agent role and stop/fence-before-failover procedure; removed contradictory multi-replica token-secret guidance. No startup replica detector added. | Publish one unambiguous deployment contract: PostgreSQL does not automatically mean high availability |
| ENG-13 | P1 | #750 | Pending | Validate effective configuration centrally and make unsafe fallbacks visible |
| ENG-14 | P1 | #751 | Pending | Protect SQLite/PostgreSQL parity with schema and migration invariants |
| ENG-16 | P1 | #752 | Pending | Make test fixtures describe invariants instead of copying implementation assumptions |
| ENG-17 | P1 | #753 | Pending | Use property-based tests for parsers and model-based tests for run/state transitions |
| ENG-19 | P1 | #754 | Pending | Make stable releases immutable, auditable and upgrade-testable |
| ENG-23 | P1 | #755 | Pending | Unify cancellation and deadlines across network calls, subprocesses and background jobs |
| ENG-24 | P1 | #756 | Pending | Make the audit trail prove consequential actions and their authorization context |
| ENG-25 | P1 | #757 | Pending | Make operational documentation executable and remove contradictory guarantees |
| FEAT-01 | P1 | #758 | Pending | Immutable run provenance capsule: explain exactly what was executed |
| FEAT-02 | P1 | #759 | Pending | Preflight checks that distinguish configured, reachable and actually usable |
| FEAT-14 | P1 | #760 | Pending | Credential doctor for workload identity, provider access and network reachability |
| FEAT-18 | P1 | #761 | Pending | Recovery workbench that gathers evidence before promoting state |
| FEAT-19 | P1 | #762 | Pending | Backup verification and restore rehearsal as a first-class administrative operation |
| COMP-13 | P2 | #763 | Pending | Test pagination and included relationships under concurrent changes |
| COMP-14 | P2 | #764 | Pending | Make accepted-but-inert compatibility behavior visible and intentional |
| UI-05 | P2 | #765 | Pending | Give large diffs predictable expansion, virtualization and copy behavior |
| UI-08 | P2 | #766 | Pending | Structure workspace creation around configuration source and execution intent |
| UI-10 | P2 | #767 | Pending | Make variable editing efficient without making secret handling ambiguous |
| UI-12 | P2 | #768 | Pending | Organize settings by task and ownership, not by backend object proliferation |
| UI-14 | P2 | #769 | Pending | Make the command palette a permission-aware remote search surface |
| UI-15 | P2 | #770 | Pending | Make the dashboard an attention queue rather than a collection of counts |
| UI-19 | P2 | #771 | Pending | Make state comparison focus on meaningful differences and provenance |
| UI-22 | P2 | #772 | Pending | Standardize form behavior, not just form appearance |
| UI-23 | P2 | #773 | Pending | Make time, duration and freshness unambiguous |
| UI-25 | P2 | #774 | Pending | Make tables work at narrow widths and with keyboard navigation |
| UI-27 | P2 | #775 | Pending | Polish login around trust, instance identity and one clear route into the product |
| UI-29 | P2 | #776 | Pending | Preserve useful content during partial refreshes and isolate secondary failures |
| UI-30 | P2 | #777 | Pending | Scope saved views and recent-workspace metadata to the signed-in identity |
| UI-31 | P2 | #778 | Pending | Make registry pages lead directly to successful consumption |
| UI-34 | P2 | #779 | Pending | Make keyboard shortcuts discoverable, scoped and conflict-free |
| UI-35 | P2 | #780 | Pending | Audit contrast, focus and motion across every supported theme |
| UI-36 | P2 | #781 | Pending | Adopt a small product-language guide and remove ambiguous operational wording |
| ENG-05 | P2 | #782 | Pending | Decompose the largest frontend screens into feature models and presentational sections |
| ENG-10 | P2 | #783 | Pending | Bound asynchronous discovery queues, not only their active concurrency |
| ENG-11 | P2 | #784 | Pending | Use a transactional outbox for durable side effects where delivery matters |
| ENG-15 | P2 | #785 | Pending | Add database query budgets and backpressure around high-cardinality operations |
| ENG-18 | P2 | #786 | Pending | Set performance budgets for user journeys, not just bundle size |
| ENG-20 | P2 | #787 | Pending | Turn dependency tooling into a controlled supply-chain workflow |
| ENG-21 | P2 | #788 | Pending | Make operational test environments deterministic and easy to reproduce locally |
| ENG-22 | P2 | #789 | Pending | Add explicit resource budgets per organization and job class |
| FEAT-03 | P2 | #790 | Pending | Compare two plans by infrastructure intent, with a “what changed since review?” view |
| FEAT-04 | P2 | #791 | Pending | Structured state-version comparison with safe output/resource summaries |
| FEAT-05 | P2 | #792 | Pending | Environment promotion pipelines that re-plan safely in each target workspace |
| FEAT-06 | P2 | #793 | Pending | Safe fleet operations with preview, immutable selection and per-workspace results |
| FEAT-07 | P2 | #794 | Pending | Dependency impact previews and selective downstream planning |
| FEAT-08 | P2 | #795 | Pending | A drift triage workflow with ownership, snoozing and explicit remediation |
| FEAT-09 | P2 | #796 | Pending | Resource inventory history and ownership, built on the existing explorer |
| FEAT-10 | P2 | #797 | Pending | An import workbench that prepares reviewable configuration, not magical one-click adoption |
| FEAT-11 | P2 | #798 | Pending | Provider and engine upgrade rehearsal against representative workspaces |
| FEAT-12 | P2 | #799 | Pending | Policy playground using retained safe fixtures and versioned policy bundles |
| FEAT-15 | P2 | #800 | Pending | Queue inspector with fairness, scheduling reasons and capacity forecasts |
| FEAT-16 | P2 | #801 | Pending | Webhook delivery console with safe replay and idempotency visibility |
| FEAT-17 | P2 | #802 | Pending | Actionable notification rules, digests and time-limited snoozing |
| FEAT-20 | P2 | #803 | Pending | Redacted support bundles with a manifest the operator can inspect before sharing |
| FEAT-21 | P2 | #804 | Pending | Secret usage and rotation impact map without exposing secret values |
| FEAT-23 | P2 | #805 | Pending | Workspace blueprints with previewed configuration and controlled updates |
| FEAT-24 | P2 | #806 | Pending | Export existing Terrence configuration into reviewable Terraform/provider adoption work |
| FEAT-25 | P2 | #807 | Pending | Access review reports with effective permissions and revocation consequences |
| FEAT-26 | P2 | #808 | Pending | One correlated operational timeline across commit, run, policy, state and notification events |
| FEAT-28 | P2 | #809 | Pending | Maintenance-aware execution scheduling with explicit exceptions |
| SVG-07 | P2 | #811 | Core fix implemented: nonmutating generator --check and CI freshness gate cover canonical SVGs, gallery, favicon SVG and standalone 404. Deterministic PNG/icon rasterization remains separate. | Make canonical SVG generation and freshness a CI contract |
| FEAT-30 | P2 after SEC-01/SEC-04 | #810 | Pending | Evidence-linked AI explanations with budgets, cancellation and deterministic fallbacks |
| UI-26 | P3 | #812 | Pending | Offer comfortable and compact density using existing design tokens |
| FEAT-13 | P3 | #813 | Pending | Opinionated policy packs with explainable defaults and staged rollout |
| FEAT-22 | P3 | #814 | Pending | Contextual runbooks attached to workspaces, failures and recovery paths |
| FEAT-27 | P3 | #815 | Pending | Unified operational search over authorized metadata, not raw secrets |
| FEAT-29 | P3 | #816 | Pending | Cost baselines and explainable estimate changes, not just a single estimate number |
| SVG-01 | P3 | #817 | Implemented: chose mild raised inner brows after comparing three expressions at 96px and 176px; canonical component and generated failed SVG updated. | Keep the character; soften the failed expression so it looks concerned, not annoyed |
| SVG-02 | P3 | #818 | Pending | Make props feel held rather than layered in front of the body |
| SVG-03 | P3 | #819 | Pending | Add a deliberate small-illustration detail tier |
| SVG-04 | P3 | #820 | Pending | Validate dark-surface legibility without abandoning the fixed brand palette |
| SVG-05 | P3 | #821 | Pending | Separate “welcome” from “verified healthy” through posture, not just an added badge |
| SVG-06 | P3 | #822 | Pending | Add at most two new poses: access blocked and connection interrupted |
| SVG-08 | P3 | #823 | Pending | Add a brand regression sheet covering real sizes, states and motion preferences |

## Validation and remaining scope

This batch is ready for review; the remaining findings are deferred to a later pass. “Implemented” identifies the delivered fix, not a claim that every wider compatibility scenario has been exercised. Partial entries name the outstanding acceptance work. Issues are referenced without automatic closure.

- Full backend (SQLite): 1868 passed, 17 skipped, zero failures; includes the real CLI lifecycle suites. The LDAP fixture used a temporary sudo Docker wrapper; no host socket permissions or repository code changed.
- Full frontend: 479 tests passed, no failures. Both typechecks and the production build pass.
- Latest plan-specific checks: 19 backend tests and 14 frontend tests passed. Unknown/ambiguous actions remain visible; state removal and deletion have distinct classifications; public projection preserves absence versus null.
- SQLite and PostgreSQL migrations were generated by Drizzle. PostgreSQL focused suites cover state reservations/serials, credential isolation, encryption rejection and real CLI state integrity. A full PostgreSQL suite has not been run locally.
- The four checksum-pinned CLI combinations passed provider and remote CLI journeys on SQLite. PostgreSQL remote CLI writes and crash injection remain unverified. The required production sandbox profile passed locally. GitHub CI has not yet run this branch.
- Sensitive-input backfill was rehearsed twice on isolated SQLite and PostgreSQL databases; it has not run against production. Existing installations must run the documented backfill to encrypt historical sensitive run inputs.
- CodeRabbit completed its accumulated review with 11 findings: seven addressed, two already satisfied, one inapplicable, one optional refactor deferred. The final plan-classification changes also passed focused regressions and manual review.
- Lint budget passes: 643 errors / zero counted warnings against baseline 762; this is not clean lint. Staged whitespace validation passes.
- Detailed validation logs remain with the original review evidence; the checked-in CLI report is in `backend/docs/cli-compatibility-results.md`.
