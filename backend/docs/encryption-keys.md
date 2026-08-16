---
title: Encryption keys
category: Administration
order: 55
description: Hold your own keys (HYOK) for encryption-at-rest.
---

# Encryption keys

Organizations can supply their own encryption keys for encryption-at-rest. This is the hold-your-own-keys (HYOK) model.

## How HYOK works

1. The organization creates a HYOK configuration.
2. The configuration holds the customer-managed key and its key versions.
3. Terrence encrypts the organization's sensitive data with the key.
4. Rotating the key rotates the data encryption.

A key version records:

- The key material reference.
- The activation time.
- The rotation state.

## Key management

The organization settings page, under encryption keys, manages configurations:

- Create a configuration.
- Add key versions.
- Rotate to a new version.
- List the versions of a configuration.

## Behavior

- Data written under a key version stays decryptable as long as the key is available.
- Losing the key loses the data. Keep key backups outside the instance.
- HYOK is per organization. Organizations without a configuration use the instance default.

## API surface

- `GET /api/v2/organizations/:org_name/hyok-configurations`
- `POST /api/v2/organizations/:org_name/hyok-configurations`
- `GET /api/v2/hyok-configurations/:id`
- `DELETE /api/v2/hyok-configurations/:id`
