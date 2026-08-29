---
title: Compatibility contracts
category: Compatibility
order: 5
description: The supported provider and Terraform/OpenTofu remote-workflow contracts.
---

# Compatibility contracts

Terrence is a self-hosted Terraform and OpenTofu run platform. Its compatibility promise is deliberately narrow and testable.

## Supported contracts

- **Terrence product API** as required by the web interface and normal operation.
- **Terraform/OpenTofu remote workflows**, including discovery, authentication, workspace selection, configuration upload, runs, plans, applies, state, and locking.
- **The official `hashicorp/tfe` Terraform provider**, tracked against the explicit version recorded in `backend/src/data/provider_surface.json`.

The provider surface is refreshed from the provider schema and verified by provider end-to-end tests. A schema entry is not considered compatible merely because the server accepts a request: supported resources and data sources must perform their provider operations successfully.

## Not a goal

Terrence does not promise:

- General HCP Terraform API compatibility.
- General Terraform Enterprise API compatibility.
- Terraform Enterprise or HCP Terraform UI parity.
- Enterprise administration or feature parity.
- Support for arbitrary software that assumes Terrence is literally TFE.

An endpoint being present in Terraform Enterprise documentation does not, by itself, make it a Terrence requirement. New compatibility work must be justified by the official provider, Terraform/OpenTofu CLI behavior, or a concrete Terrence product need.

An Explorer bulk action is an API-only operation. Its durable records use the logical `explorerBulkActionRecords` model over the historical `change_requests` table, and may emit the provider-valid `team:change_request` notification shape. Terrence does not expose a Change Requests list, detail, lifecycle, or UI for these records.

## Ownership classes

- `core`: first-class Terrence product functionality.
- `provider`: backend/API behavior retained for `hashicorp/tfe` compatibility; it does not imply a WebUI.
- `cli`: behavior required by Terraform/OpenTofu remote workflows.
- `internal`: operation, security, administration, and integration infrastructure.

## Product capability guidance

The CORE product is organizations, projects, workspaces, runs, plans/applies, state, variables, VCS, the private registry, users and teams, agents, notifications, run tasks, policies, OIDC/workload identity, audit logging, and safe administration. These surfaces receive normal WebUI, documentation, and regression coverage.

PROVIDER-only resources such as HYOK, no-code module definitions, token TTL policies, audit trail tokens, module sharing, provider sets, and advanced agent-pool scoping remain headless unless a concrete product decision promotes one. CLI ownership covers Terraform/OpenTofu discovery, authentication, workspace selection, uploads, remote runs, state, and locking. INTERNAL ownership covers infrastructure needed to operate, secure, and integrate Terrence; it does not imply a user-facing feature.

## Route ownership

The manifest's `route_ownership` map covers every route module registered by `backend/src/app.ts`. A provider-only owner means the route remains for provider interoperability but must not acquire a normal-product UI by implication. New routes must be justified by one of the four supported classes; copying an HCP Terraform or Terraform Enterprise endpoint solely for parity is not sufficient.
