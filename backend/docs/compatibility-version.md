---
title: Compatibility version policy
category: Compatibility
order: 10
description: How Terrence tracks Terraform/OpenTofu remote-workflow compatibility.
---

# Compatibility version policy

Terrence tracks a small, testable compatibility boundary rather than claiming parity with a complete hosted Terraform product.

## Contracts

- Terraform and OpenTofu remote workflows are tested as CLI behavior.
- The official `hashicorp/tfe` provider is tested against the released version recorded in `backend/src/data/provider_surface.json`.
- Terrence-native product behavior is tested by the normal API and WebUI suites.

See [Compatibility contracts](compatibility) for the ownership model and the explicit non-goals.

## Discovery version

The single source of truth for the remote-workflow discovery version is the `COMPATIBILITY_VERSION` constant in `backend/src/lib/constants.ts`:

```ts
export const COMPATIBILITY_VERSION =
  process.env.TERRENCE_COMPATIBILITY_VERSION?.trim() ||
  process.env.TERRENCE_TFE_COMPATIBILITY_VERSION?.trim() ||
  "2.5.0";
```

This constant drives the discovery headers emitted by the server:

- `TFE-Version`
- `X-TFE-Version`
- `X-TFE-Current-Version`

These names are preserved because Terraform clients read them. They identify a wire-level interoperability value, not a claim that Terrence is Terraform Enterprise or HCP Terraform.

## Release gate

A provider-surface change is release-worthy only after all of the following are true:

1. The catalog was generated from the targeted provider schema.
2. Resource and data-source counts and schema hashes are internally consistent.
3. Provider E2E coverage is green for Terraform and OpenTofu.
4. Remote-workflow tests remain green.

A newly released provider is not automatically supported merely because schema generation succeeds. Compatibility is claimed only after functional E2E coverage is green.

## Extensions

Terrence-native extensions must not change the default behavior of supported remote workflows. Features such as policies, run tasks, notifications, Landlock, and integrations are maintained according to the ownership manifest and their own tests.

## Provider lifecycle evidence

The provider catalog records fixture inclusion, not complete behavioral proof for every resource. A green provider job emits `provider-lifecycle-results` JSON artifacts with the actual CLI/provider versions, database, sandbox profile and named fixture claims. A failed workflow emits no success record for that combination.

The initial fixture resources currently verify create/read, two consecutive unchanged plans, an unchanged apply and an empty state after destroy. Additional named checks cover setting, clearing and restoring a variable-set description with convergence after each change, and importing a team into minimal configuration with no planned changes. These checks run with Terraform and OpenTofu; CI also runs the Terraform fixture with required production sandboxing, and the PostgreSQL backend job runs the same provider journeys against isolated PostgreSQL databases.

Import coverage for other families, optional/null transitions beyond variable-set descriptions, and resource-specific negative permission contracts remain incomplete. Schema coverage alone does not establish those behaviors. Headless API/provider resources remain valid without a dedicated UI editor.

## Pinned CLI matrix and canaries

[The generated CLI results page](cli-compatibility-results) lists the tested floor/current combinations and binary digests. Pins live in `backend/tests/e2e/cli_matrix.json`; the provider stays at the version in the tracked provider catalog. Set `TERRENCE_E2E_CLI=terraform|tofu` and `TERRENCE_E2E_TIER=floor|current` to reproduce a row. An exact `TERRENCE_E2E_TERRAFORM_VERSION` or `TERRENCE_E2E_TOFU_VERSION` overrides the selected pin for local investigation.

CI runs all four pinned combinations and publishes `cli-compatibility-report` only after the complete matrix succeeds. The generated Markdown and underlying successful JSON reports are the publication inputs; refresh the checked-in release snapshot with `bun backend/scripts/report-cli-compatibility.ts RESULTS_DIR backend/docs/cli-compatibility-results.md` after downloading that artifact. Never regenerate a support claim from only the passing subset of a failed matrix.

The weekly scheduled run selects `TERRENCE_E2E_TIER=canary`, which resolves the latest stable CLI independently of the pins. Its provider fixtures also cover variables, policies and registry objects. Failure creates a deduplicated review issue with a link to the run and redacted CLI stdout/stderr artifacts. Canary results are experimental, do not satisfy a missing pinned row, and never rewrite the support floor. Browser-based CLI login, agent protocol negotiation and encrypted-state compatibility remain separate contracts.

## Public plan projection

Public plan JSON carries `public_plan_version: 1` alongside the engine's `format_version`. It excludes raw variables, configuration and state; sensitivity masks govern exposed change values. An absent value remains absent, distinct from explicit `null`. Ordered known action names are retained; unknown action names are replaced by `unsupported` rather than copied or silently dropped. The plan viewer keeps unsupported operations visible and asks the reviewer to consult the CLI plan. `forget` means removal from state without destruction; a `delete` remains destruction regardless of its reason. This is a partial compatibility contract; a complete real-engine fixture corpus and unknown-extension adapters remain tracked in issue #719.
