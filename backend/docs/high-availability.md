---
title: High availability
category: Administration
order: 45
description: Active-active API replicas, coordinator election, shared storage, and failover semantics.
---

# High availability

Terrence can run multiple active API/control-plane replicas when PostgreSQL is the database backend.

The supported topology is:

```text
                         ┌─ Terrence replica A ─┐
Users / Terraform ─ LB ─┼─ Terrence replica B ─┼── HA PostgreSQL
                         └─ Terrence replica C ─┘
                                  │
                         shared STORAGE_DIR
                                  │
                         remote agent pools
```

Every replica serves the API and UI. PostgreSQL elects one replica as the control-plane coordinator for scheduler-style work. Durable jobs keep their existing database leases and can be processed by any worker-enabled replica.

## Enable HA

Set the following on every replica:

```sh
TERRENCE_HA_ENABLED=true
DATABASE_URL=postgresql://...
STORAGE_DIR=/mnt/shared/terrence
PUBLIC_URL=https://terraform.example.com

ENCRYPTION_PASSWORD=...
TERRENCE_TOKEN_HASH_SECRET=...
SIGNED_URL_SECRET=...
```

Each replica must also have a unique node identity:

```sh
TERRENCE_NODE_ID=terrence-1
# TERRENCE_NODE_ID=terrence-2
# TERRENCE_NODE_ID=terrence-3
```

HA startup fails closed unless PostgreSQL, an explicit `STORAGE_DIR`, `PUBLIC_URL`, the three shared secrets, and an explicit non-blank node ID are configured. A second live process cannot claim the same `TERRENCE_NODE_ID`.

SQLite remains a single-process backend.

## Shared storage

`STORAGE_DIR` must refer to the same shared POSIX filesystem from every replica. Terrence can verify that the path is configured and writable, but it cannot prove that separate paths are backed by the same storage.

Suitable deployments include NFS, EFS, Azure Files, CephFS, or another filesystem with equivalent shared visibility and locking semantics.

Shared storage is required for configuration archives, plan JSON, saved plans, recovery data, exports, registry/module archives, support artifacts, and shared encryption salt/key material. Do not run HA replicas with independent local `STORAGE_DIR` volumes.

Binary caches may be separated from shared storage with `TERRENCE_BINARY_CACHE_DIR` when desired.

## Coordinator election

The coordinator uses the PostgreSQL `control_plane_leases` table:

- lease lifetime: 15 seconds
- renewal interval: 5 seconds
- takeover: atomic after expiry
- every takeover increments a monotonically increasing fencing epoch
- graceful shutdown expires the lease only after locally owned execution work has drained or been terminated

Only the coordinator runs:

- pending-run scheduling
- scheduled apply discovery
- auto-destroy discovery
- assessment discovery/claiming
- interrupted local-run reconciliation
- shared upload/temp sweeps
- shared control-event retention

All worker-enabled replicas may process individually leased durable jobs.

If a replica loses coordinator ownership, it immediately stops its scheduler generation and terminates locally running Terraform/OpenTofu processes. It cannot resume scheduler work until it later acquires a new coordinator epoch.

## PostgreSQL migrations

Every replica may start concurrently against a fresh or upgraded database. PostgreSQL migrations are serialized with a session advisory lock, so exactly one startup process applies or verifies migrations at a time.

This makes concurrent boot safe. It does **not** by itself guarantee that arbitrary mixed Terrence versions are rolling-upgrade compatible. Until a release explicitly documents mixed-version compatibility, replace/drain replicas using the normal upgrade procedure rather than assuming old and new binaries can serve concurrently.

## Cross-replica events and SSE

HA mode persists control events in `control_events` and uses PostgreSQL `LISTEN/NOTIFY` for low-latency fan-out.

Each replica:

1. listens on the shared PostgreSQL control-event channel;
2. catches up from the durable event table in database-clock order;
3. republishes received events to its local in-process subscribers and SSE connections.

Sticky sessions are not required for run events or authorization-change stream invalidation.

Control events are retained for 24 hours and pruned by the elected coordinator.

## Readiness and load balancers

API readiness is independent of coordinator ownership. A healthy follower remains ready behind the load balancer.

Node heartbeats expose:

- `leader`, `follower`, `ineligible`, or `standalone` role
- current coordinator fencing epoch
- version and readiness checks
- heartbeat freshness

The Operations Center shows the current coordinator, lease expiry, fencing epoch, HA topology, and every node's role.

`TERRENCE_DISABLE_WORKER=1` makes an HA replica coordinator-ineligible and disables durable workers on that replica, but does not by itself make the API unready.

## Local execution failover

This HA mode provides automatic **control-plane** failover. Local Terraform/OpenTofu execution is deliberately conservative:

- the elected coordinator owns local scheduler execution;
- lease loss terminates its local subprocesses;
- after coordinator takeover, interrupted local runs are reconciled;
- an interrupted apply is not automatically replayed.

This avoids duplicate applies during a node failure or network partition.

Local execution does not yet have per-run database lease/fencing columns or a cross-replica workspace execution lease. That stronger execution-ownership model is the remaining step before Terrence can claim transparent local-executor failover. Agent execution and durable jobs already have their own heartbeat/fencing mechanisms and therefore benefit more directly from control-plane HA.

## Failure behavior

Expected failure sequence:

```text
leader stops renewing
        │
        ├─ local scheduler stops / subprocesses terminate when lease loss is observed
        │
        └─ lease expires (<= ~15s from last successful renewal)
                    │
                    ▼
           follower atomically takes over
                    │
                    ├─ fencing epoch increments
                    ├─ interrupted local work is reconciled
                    ├─ shared-file sweep runs
                    └─ scheduler starts
```

A killed leader is not automatically removed from the node inventory; its heartbeat becomes stale. Reusing that node ID is permitted only after the previous heartbeat is stale or the old process marked itself draining.

## Backups

Back up PostgreSQL and the shared `STORAGE_DIR` from the same logical point. The shared directory contains encryption salt/material and artifacts that are not recoverable from the database alone.

See [Operations](operations.md) and [Database](database.md) for the backup and restore procedure.

## Verification

PostgreSQL CI starts three real Terrence processes against one fresh database and shared storage. The HA system test verifies:

- concurrent fresh-database startup and serialized migrations;
- one coordinator and two followers;
- duplicate live node IDs are rejected;
- an SSE stream on one replica receives authorization invalidation published by another;
- `SIGKILL` of the coordinator causes automatic takeover by a different replica;
- the replacement coordinator has a higher fencing epoch;
- surviving replicas remain HTTP healthy.
