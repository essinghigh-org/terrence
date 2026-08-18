---
title: Compatibility version policy
category: Compatibility
order: 10
description: How Terrence declares and advances the API compatibility baseline it targets.
---

# Compatibility version policy

Terrence implements a subset of the JSON:API request/response format used by Terraform CLI remote operations and related open-source tooling. To keep that compatibility claim verifiable and stable, Terrence declares a single **compatibility baseline** per release and advances it only when the differential suite is green.

## Declaration

The single source of truth for the reported compatibility version is the `COMPATIBILITY_VERSION` constant in `backend/src/lib/constants.ts`:

```ts
export const COMPATIBILITY_VERSION =
  process.env.TERRENCE_COMPATIBILITY_VERSION?.trim() || "2.0.0";
```

This constant drives every compatibility-discovery header emitted by the server:

- `TFE-Version`
- `X-TFE-Version`
- `X-TFE-Current-Version`

All three headers must carry the same value derived from `COMPATIBILITY_VERSION`. Do not hardcode release strings in route handlers. The header names above are part of the wire format Terrence reproduces so that existing tooling behaves unchanged; they are preserved for interoperability, not as an affiliation or endorsement.

> **Note on naming:** these header and constant names are carry-over identifiers from the open format Terrence reproduces. Terrence is an independent implementation and is not affiliated with HashiCorp or its products. The names are kept only because clients read them.

## Baseline

The current declared baseline is the value of `COMPATIBILITY_VERSION` (`2.0.0` out of the box). This corresponds to the 2.0.x API surface of the documented remote-workflow format at the audit baseline date.

## Advancing the baseline

Advance the baseline only when the following gates are green:

1. The black-box differential suite passes against a real reference instance of the target format (see `compatibility parity audit` items TEST-002 through TEST-006).
2. The `go-tfe` compatibility matrix (TEST-003) passes at both the current and oldest-supported versions against the new baseline.
3. The remote-workflow provider acceptance coverage (TEST-004) passes with the approved expected-difference allowlist.
4. The real Terraform CLI remote workflow suite (TEST-005) passes.
5. The real `tfc-agent` binary (TEST-006) succeeds against Terrence at the new baseline.

New upstream fields or endpoints are never silently assumed compatible. They enter the implementation as **untriaged failures** against the differential suite until explicitly assessed and either accepted as an additive extension or closed as a parity gap.

## Overriding the baseline

The `TERRENCE_COMPATIBILITY_VERSION` override changes the advertised
`TFE-Version`, `X-TFE-Version`, and `X-TFE-Current-Version` headers **without
changing actual Terrence behavior**. Because clients use the advertised
version to select API behavior, advertising an untested baseline can cause a
client to exercise code paths Terrence has not validated.

Therefore:

- In production, only advertise a baseline the differential suite has proven
  green (see [Advancing the baseline](#advancing-the-baseline)).
- Use the override only for test/dev isolation where a fixed advertised value
  is needed and the real reference oracle is present. Never ship a non-default
  override in production images.

## Extensions policy

Terrence extensions must never change the default or observable behavior of a remote workflow. Concretely:

- **Parity behavior is the default.** Where Terrence adds an extension (OpenTofu, Infracost, MCP, change requests, scorecards, Landlock, etc.), the extension must be opt-in or additive. A default Terrence deployment must behave as the documented format does for every shared workflow.
- **Known boundary crossings are bugs.** The audit evidence cites three active violations: OpenTofu-first organization defaults (`ORG-001`), the Infracost/config split (`COST-001`/`COST-002`), and Landlock-as-required (`OPS-001`/`AGENT-025`). Each must be reclassified to opt-in/additive.
- **Extensions are out of the compatibility contract.** Extension endpoints and fields do not count toward the compatibility baseline and are not asserted by the differential suite unless they override a default.

## Scope

- Absence of licensing/billing restrictions is not treated as a bug; Terrence is open source. Entitlement fields still require truthful compatible values because clients consume them.
- Terrence-specific extensions (OpenTofu, Infracost, MCP, change requests, scorecards, Landlock, etc.) are allowed only when they do not change the default or observable behavior of a remote workflow.
