---
title: Upgrading
category: Administration
order: 44
description: Upgrade safely between releases, and what to back up first.
---

# Upgrading

This page covers the most common operation: moving a Terrence instance to a newer release. Terrence ships `latest` and nightly container tags.

## Upgrade steps

1. Back up first. Stop the instance and copy the database plus the whole storage directory (see [Operations](operations)). There is no rollback path: schema migrations are forward-only, so a pre-upgrade backup is the only way back.
2. Pull the new image (`docker compose pull`) and restart (`docker compose up -d`).
3. Migrations run automatically at startup, forward-only. Watch the first boot log for migration errors before sending traffic.

## What is safe

- `docker compose pull` plus `up -d` is the supported path. The container entrypoint applies migrations before the server accepts traffic.
- Skipping versions is fine: every pending migration applies in order at boot.
- Configuration is backward compatible within documented defaults. New variables default to previous behavior unless the release notes say otherwise.

## What is not supported

- Downgrades. Do not run an older image against a database migrated by a newer one; restore the pre-upgrade backup instead.
- Multiple control-plane replicas during the upgrade. Terrence is a single-process application; keep exactly one instance running.
- Restoring only the database without the matching storage directory. Encrypted blobs (state payloads, secrets, sensitive variables) will not decrypt.

## Nightly tags

Nightly builds track the default branch and may include unfinished migrations. Do not run nightly against data you cannot afford to rebuild; nightly-to-stable moves are upgrades like any other, but stable-to-nightly-to-stable round trips are not tested.
