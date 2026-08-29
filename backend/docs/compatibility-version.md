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
