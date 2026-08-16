---
title: Registry
category: Registry and VCS
order: 10
description: The private module and provider registry.
---

# Registry

The registry hosts private modules and providers for the organization. Terraform resolves `source` references against the registry during runs and local plans.

## Modules

Modules are versioned bundles of Terraform configuration. Publish a module version by uploading an archive or by connecting a repository.

### Publishing by upload

The API accepts a module version with an archive:

1. Create the module.
2. Create a version.
3. Upload the archive to the version.
4. Terrence ingests the archive and stores the metadata.

### Publishing from a repository

A repository can publish through the registry-tag webhook:

1. Connect the module to a repository.
2. Tag the repository with a version.
3. The webhook tells Terrence to fetch and publish the version.

See [Webhooks](webhooks) for the webhook configuration.

### Module structure

A module archive contains:

- The root module.
- Optional submodules under `modules/`.
- Optional examples under `examples/`.

Terrence extracts metadata per section: inputs, outputs, resources, and dependencies. The module page shows the metadata and the README for each section.

### Versioning

Module versions follow semantic versioning. Version status is tracked per version. A failed ingestion shows the error and can be retried.

### No-code modules

A no-code module is a module with a published configuration schema. Workspaces can be created from it without writing configuration. See [No-code provisioning](no-code).

### Module sharing

Organizations can share modules with other organizations. The module-sharing settings control which modules are visible outside the owning organization.

## Providers

Providers follow the same registry model. Publish provider versions with metadata:

- Namespace and name.
- Version.
- Platform-specific archives.
- Signing key.

Provider versions are verified with the organization's GPG keys when configured.

## Resolution in runs

During a run, Terraform resolves registry references against the instance hostname. The run token authenticates the resolution. Private modules and providers are available only to runs and users with access.

Local `terraform init` resolves the same way, using the credentials from `terraform login`.

## Registry compatibility

The registry serves the standard discovery paths:

- `/v1/modules/` module endpoints.
- `/v1/providers/` provider endpoints.

The `terraform` CLI and `tofu` work without extra configuration.

## API surface

- `GET /api/v2/organizations/:org_name/registry-modules`
- `POST /api/v2/organizations/:org_name/registry-modules`
- `POST /api/v2/registry-modules/:id/versions`
- `POST /api/v2/registry-modules/:id/versions/:version/upload`
- `GET /api/v2/organizations/:org_name/registry-providers`
- `POST /api/v2/registry-providers/:id/versions`
