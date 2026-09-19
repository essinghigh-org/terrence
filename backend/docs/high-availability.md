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

## PostgreSQL is the quorum boundary

Terrence does not implement a second Raft/Paxos-style quorum between control-plane replicas. PostgreSQL is the single authoritative coordination boundary for HA ownership. Deploy PostgreSQL with whatever database-level HA model fits the environment (for example a managed multi-AZ service or a separately operated PostgreSQL cluster) and present Terrence with one writable endpoint whose transactions provide the database's normal consistency guarantees.

Terrence does not inspect or vote on individual PostgreSQL members. If the PostgreSQL deployment cannot establish write authority, Terrence cannot renew or acquire coordinator/run execution leases. A local executor that cannot continue proving ownership fails closed and self-fences instead of continuing optimistically.

This keeps one source of truth for ownership: a PostgreSQL transaction either commits the lease/fencing transition or it does not.

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

If a replica loses coordinator ownership, it immediately stops its scheduler generation. Locally running Terraform/OpenTofu executions are not revoked merely by the coordinator handoff: each run is independently authoritative while its own run/workspace execution lease remains valid. If the database connectivity or ownership needed by that run is lost, the run's own watchdog self-fences it.

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

The Operations Center shows the current coordinator, lease expiry, fencing epoch, HA topology, every node's role, and aggregate active/expired local execution lease counts.

`TERRENCE_DISABLE_WORKER=1` makes an HA replica coordinator-ineligible and disables durable workers on that replica, but does not by itself make the API unready.

## Local execution fencing and failover

Local Terraform/OpenTofu execution has a second ownership layer in addition to the control-plane coordinator:

- each local plan/apply acquires a PostgreSQL-backed run execution lease for 30 seconds and renews it every 5 seconds;
- every new ownership generation increments the run's monotonically increasing fencing token;
- the same transaction also acquires the workspace execution lease, so only one local run can own mutation/execution rights for a workspace at a time;
- automatic plan-to-apply execution reuses the same in-process lease generation instead of handing ownership off mid-run;
- a later manual or scheduled apply acquires a new generation after the plan lease is released.

A local executor that loses the lease immediately invalidates its entire async execution context, force-terminates the affected process group/cgroup, and is prevented from starting another Terraform/OpenTofu/provider process. Database writes made by the execution path include the current owner, fencing token, and database-clock expiry in their compare-and-set predicate.

Authoritative state publication is stronger than a check followed by a write: Terrence conditionally locks the run and workspace ownership rows inside the same transaction that allocates and inserts the state serial. A higher-token takeover therefore waits until the current authoritative commit finishes; once takeover commits, the old generation cannot publish state.

Shared execution artifacts use the same boundary. Plan JSON, saved plans, and cost-estimate bytes are prepared in private temporary files; the final atomic rename is performed while the current run/workspace ownership rows are locked. A stale executor cannot replace artifacts belonging to a newer generation.

After a process failure:

- a newly elected coordinator respects any still-live run execution lease, even if the previous coordinator is gone;
- expired execution leases are checked by the coordinator every 10 seconds;
- pre-execution work can be safely requeued;
- interrupted planning/apply execution is reconciled conservatively;
- an interrupted apply is **never automatically replayed** because infrastructure may already have changed;
- expired owner metadata on final/resting runs is garbage-collected without decreasing the run's fencing token.

This gives Terrence database-enforced local execution ownership and fencing. It does not make an arbitrary Terraform apply transactionally movable between hosts: external cloud mutations performed before a crash cannot be rolled back by PostgreSQL. Recovery therefore remains intentionally conservative.

Agent execution and durable jobs keep their existing independent lease/fencing mechanisms.

## Failure behavior

Expected failure sequence:

```text
leader stops renewing
        │
        ├─ local scheduler generation stops when coordinator loss is observed
        │
        └─ coordinator lease expires (<= ~15s from last successful renewal)
                    │
                    ▼
           follower atomically takes over
                    │
                    ├─ fencing epoch increments
                    ├─ still-live run execution leases remain authoritative
                    ├─ expired local execution leases are recovered separately
                    ├─ shared-file sweep runs
                    └─ scheduler starts
```

Coordinator ownership and run execution ownership are independent. Electing a new coordinator does not authorize it to overwrite a still-live run lease owned by the previous node.

For an individual local run, the failure sequence is:

```text
last successful run-lease confirmation
                 │
                 ├─ renewal succeeds → lease extends
                 │
                 └─ renewal fails/hangs or process dies
                              │
                local watchdog self-fences by lease expiry
                              │
                              ▼
                 PostgreSQL run lease expires (<= 30s)
                              │
                              ▼
             another generation may atomically claim
                              │
                              ├─ fencing token increments
                              └─ expired-run recovery runs within ~10s
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

Execution-lease tests additionally verify:

- exactly one run can own a workspace at a time;
- every ownership takeover increments the run fencing token;
- stale owners cannot renew, release, or publish state;
- PostgreSQL row locks keep a higher-token takeover blocked until an in-flight authoritative state/artifact fence transaction commits;
- expired interrupted leases recover while still-live leases remain authoritative;
- expired ownership metadata on resting/final runs is cleared without resetting the fencing token.
