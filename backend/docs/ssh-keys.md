---
title: SSH keys
category: Registry and VCS
order: 35
description: SSH keys for private repository and module access.
---

# SSH keys

SSH keys authenticate Git operations over SSH. Use an SSH key when a repository is reachable over SSH but not through the VCS provider API.

## Create an SSH key

Organization settings, under SSH keys:

1. Generate or paste an SSH private key.
2. Give it a name.
3. Save.

The key is stored per organization. The private key material is never returned by the API after creation.

## Use an SSH key

Workspaces and registry sources that clone over SSH reference a key by ID. The clone uses the key automatically.

Assign the key to a workspace in the workspace settings, or reference it when creating the workspace.

## Rotation

Replace a key by creating a new one and updating the references. Delete the old key once no source uses it.

Key access is audited. Strict audit mode records key reads.

## API surface

- `GET /api/v2/organizations/:org_name/ssh-keys`
- `POST /api/v2/organizations/:org_name/ssh-keys`
- `GET /api/v2/ssh-keys/:ssh_key_id`
- `DELETE /api/v2/ssh-keys/:ssh_key_id`
