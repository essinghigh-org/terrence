---
title: Cost estimates
category: Workspaces and runs
order: 70
description: Estimate plan costs with the Infracost integration.
---

# Cost estimates

Cost estimates are an optional convenience integration, not a cost-management product. For richer cost, security, compliance, or approval workflows, use a Run Task so the external tool owns that domain.

## Enable Infracost

Set these environment variables:

| Variable | Purpose |
|---|---|
| `INFRACOST_ENABLED=true` | Enable cost estimation. |
| `INFRACOST_VERSION` | The Infracost version to run. Defaults to `0.10.45`. |
| `INFRACOST_BINARY` | Optional path to a custom Infracost executable. |
| `INFRACOST_API_KEY` | The Infracost API key for price lookups. |

Terrence manages the Infracost binary like the Terraform binaries: it downloads the pinned version into the storage directory and verifies the checksum. The optional `INFRACOST_BINARY` path bypasses the managed binary.

## When estimation runs

After a plan completes, the worker runs Infracost against the plan. The estimate appears on the run page with the projected monthly cost.

A plan with no resource changes produces no estimate. If the Infracost binary cannot be resolved or installed, the run continues without cost data and the estimate is recorded with an `unavailable` status (the run page explains that estimation is not installed in this image). Other estimation failures record an `errored` status with the tool output. Cost estimation never blocks the apply.

## Stored artifacts

The run stores the estimate timestamps and the parsed cost output. Each finished estimate also retains the Infracost tool version, pricing date when reported, currency, time basis, supported-resource count, and bounded assumptions list. The web interface renders this provenance beside the summary so a reviewer can tell which pricing context produced it.

When Infracost supplies a past breakdown, Terrence records it as the comparison baseline and emits bounded resource-level deltas (including the project/module name and resource address). A baseline is comparable only when both sides use the same currency and monthly time basis. Missing prices remain unsupported and are called out as warnings; they are never silently treated as zero. If no baseline is present, the prior value is shown as zero for compatibility only and the UI labels the comparison unavailable.

These values are estimates, not billing guarantees. Resource increases link back to the run's plan review, and unsupported or usage-dependent pricing remains visible as a caveat. Only the documented plan JSON contract is written to the external estimator; credentials are kept outside the run work directory and are removed after the estimate completes.

## API surface

- `GET /api/v2/runs/:id/cost-estimate`
- `GET /api/v2/plans/:id/cost-estimate`
