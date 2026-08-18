---
title: No-code provisioning
category: Registry and VCS
order: 20
description: Create workspaces from published modules without writing configuration.
---

# No-code provisioning

No-code provisioning creates workspaces from a published module. The module declares its inputs and Terrence renders a form. No Terraform configuration is written.

## Publish a no-code module

A module becomes no-code when it is published to the registry with a configuration schema. The schema describes the module inputs, their types, and defaults.

See [Registry](registry) for publishing.

## Create a workspace from a module

1. Open the no-code provisioning page.
2. Pick a published module.
3. Fill in the module inputs in the form.
4. Choose the workspace name and project.
5. Create the workspace.

Terrence creates a workspace whose configuration source is the module version. The first run plans and applies the module.

## Upgrades

A no-code workspace tracks the module version it was created from. When a new module version publishes, the workspace can upgrade:

- The upgrade targets the new version.
- Proposed variable values carry over.
- The upgrade is confirmed before it runs.

The no-code upgrade runs with the new configuration. The workspace page shows the upgrade state.

## Requirements

- The module must be published in the organization's registry.
- The module version must include a configuration schema.
- The workspace requires a project.

## API surface

- `GET /api/v2/organizations/:org_name/no-code-modules`
- `POST /api/v2/organizations/:org_name/no-code-modules`
- `GET /api/v2/no-code-modules/:id/configuration-schema`
- `POST /api/v2/workspaces/:id/actions/no-code-upgrade`
