---
title: Tested CLI compatibility
category: Compatibility
order: 11
description: Generated results from the successful pinned CLI compatibility matrix.
---

# Tested CLI compatibility

Generated from successful lifecycle artifacts by `backend/scripts/report-cli-compatibility.ts`. Missing combinations, wrong provider versions or incomplete named lifecycle fixtures prevent generation. The latest successful CI run publishes the `cli-compatibility-report` artifact; this checked-in page is a release snapshot of that evidence.

| CLI | Pin | Tested version | Completed (UTC) | Binary SHA-256 |
|---|---|---|---|---|
| Terraform | floor | 1.6.6 | 2026-09-06T00:43:10.100Z | `5e1a9226bef2b38b5bc74d71e84389d1a0d135afc54b8612a18028cc5735a355` |
| Terraform | current | 1.16.1 | 2026-09-06T00:54:25.564Z | `0b5a4e400548d9538af88a4c5a2726b97b38751b8f577aa6687ad051ba2070f2` |
| OpenTofu | floor | 1.6.3 | 2026-09-06T00:45:47.265Z | `2429d2a9fe330bb658532118a4c36c9e085d5620d7c79b8fb90e4eddf762993b` |
| OpenTofu | current | 1.12.6 | 2026-09-06T00:55:20.077Z | `8f95cbe1523ef7b7913773634a6d6ac94c38f3c8eadba2e18b1e5b01567561ad` |

These combinations use SQLite, a local worker and a trusted HTTPS proxy. CLI archives pass upstream checksum verification and cached executables are checked against their integrity records. Provider version: `hashicorp/tfe 0.80.0`.

## What the results establish

- **Tested:** API login, CLI discovery/init, remote plan, interactive apply approval, state pull and an unchanged remote plan. The provider fixture also checks repeated convergence, normalized state after optional-value transitions, named priority-family pagination and permission probes, variable-set description transitions, minimal team import and destroy.
- **Supported by contract:** CLI versions between each floor and current pin use the same remote-workflow API contract, but are not individually verified by this matrix. Discovery protocol versions and agent protocol support are separate from CLI version support.
- **Experimental:** versions newer than the current pin, including scheduled canaries. A failed canary opens a review item and does not change these pins or replace a successful matrix report.
- **Unsupported by this matrix:** versions below the floor, encrypted-state workflows, browser-based CLI login, alternate agent implementations, and untested plan/state formats. The state journey verifies a plain JSON v4 round trip; it does not establish compatibility with arbitrary future formats.

PostgreSQL and required-sandbox jobs provide separate evidence. They do not imply every database/security/version permutation was exercised. Full import/null coverage for every provider resource remains outside these measured claims.
