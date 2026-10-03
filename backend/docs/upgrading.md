---
title: Upgrading
category: Administration
order: 44
description: Upgrade safely between releases, and what to back up first.
---

# Upgrading

This page covers the most common operation: moving a Terrence instance to a newer release. Stable images use immutable `vX.Y.Z` tags and are also addressed by their registry digest. `latest` and `nightly` are convenience channels, not recovery identifiers.

## Standalone upgrade steps

1. Back up first. Stop the instance and copy the database plus the whole storage directory (see the [Operations backup procedure](operations#backups)). There is no rollback path: schema migrations are forward-only, so a pre-upgrade backup is the only way back.
2. Select the exact `vX.Y.Z@sha256:...` image from the release's redacted build manifest, then pull it and restart (`docker compose pull` and `docker compose up -d`).
3. Migrations run automatically at startup, forward-only. Watch the first boot log for migration errors before sending traffic.
4. Check the deployed image before reopening traffic. `GET /healthz` proves liveness, `GET /readyz` proves the local database and storage are ready and includes the applied schema version, and an authenticated `GET /api/v1/metadata` returns the application version and build SHA. Use [Operations health endpoints](operations#health-endpoints) for the exact routes.

## HA rolling upgrades

Explicitly enabled PostgreSQL HA deployments can replace replicas one at a time within the supported application and HA protocol version window. PostgreSQL alone does not enable this topology: shared storage/secrets, a common public URL and unique node IDs are required. Follow the [HA prerequisites, mixed-version rules and node-drain procedure](high-availability.md).

Keep a consistent pre-upgrade database/storage backup and the release manifest. Drain the replica being replaced, wait for its owned work and coordinator handoff to finish, deploy the exact release image, and verify readiness and its advertised versions before returning it to service. Then replace the next replica. PostgreSQL migration locking serializes schema checks, and rolling migrations must preserve the documented previous-release contract. Protocol-1 replicas use graceful process shutdown until every replica supports the drain lifecycle.

For recovery from backup, fence all old replicas before switching the cluster to the matching restored database, storage and secrets. A per-node drain is not a cluster restore or a downgrade procedure.

## What is safe

- `docker compose pull` plus `up -d` is the supported path. The container entrypoint applies migrations before the server accepts traffic.
- Skipping versions is fine: every pending migration applies in order at boot.
- Configuration is backward compatible within documented defaults. New variables default to previous behavior unless the release notes say otherwise.

## What is not supported

- Downgrades. Do not run an older image against a database migrated by a newer one; restore the pre-upgrade backup instead.
- Overlapping standalone instances, any SQLite replica topology, or HA peers outside the documented application/protocol compatibility window. Use the HA rollout procedure only when HA is explicitly enabled.
- Restoring only the database without the matching storage directory. Encrypted blobs (state payloads, secrets, sensitive variables) will not decrypt.

## Release provenance and rehearsal

Each stable release publishes a build manifest containing the source commit, image digest, SQLite and PostgreSQL migration-set digests, the tracked CLI/provider matrix digest, and hashes of the redacted lifecycle evidence. The manifest contains no credentials or state values. Keep it with the database and storage backup so an operator can prove exactly which code and migrations were run.

Before promotion, CI runs the upgrade fixture from earlier bundled migration sets. It seeds a prior-release user, state payload, encrypted workspace/MFA secrets, and a real configuration archive, then verifies that those values remain readable, the archive reference remains available, duplicate identities are still rejected, migrations are idempotent, and `tfectl --version` still works. The same fixture is run against SQLite and PostgreSQL where the service is configured for PostgreSQL. Reproduce the database checks with:

```sh
bun test backend/tests/db/upgrade-invariants.test.ts backend/tests/db/domain-invariants.test.ts --max-concurrency=1 --no-orphans
```

The fixture does not advertise downgrade safety. Migrations are forward-only; restore the pre-upgrade database and storage backup to return to an earlier release.

## Nightly tags

Nightly builds track the default branch and may include unfinished migrations. Do not run nightly against data you cannot afford to rebuild; nightly-to-stable moves are upgrades like any other, but stable-to-nightly-to-stable round trips are not tested.
