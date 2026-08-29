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

A plan with no resource changes produces no estimate. If the Infracost binary is unavailable, the run continues without cost data. Cost estimation never blocks the apply.

## Stored artifacts

The run stores the estimate timestamps and the parsed cost output. The web interface renders the cost summary.

## API surface

- `GET /api/v2/runs/:id/cost-estimate`
- `GET /api/v2/plans/:id/cost-estimate`
