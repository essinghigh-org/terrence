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

## Rolling upgrades and version compatibility

HA nodes advertise two versions:

- the application release (`1.4.0`, `1.5.0`, and so on);
- an HA protocol version for cross-replica semantics.

A node may join only when both checks pass:

1. released builds are on the same major version and differ by at most one minor version;
2. the HA protocol windows intersect.

Development builds do not have a meaningful release number, so only the protocol check applies to them.

HA-3 uses protocol `2` and accepts protocol `1`. A row created by a pre-HA3 node has no protocol value and is treated as protocol `1`. Only peers with a fresh heartbeat participate in the check. An incompatible node fails startup and readiness.

The protocol version must be bumped when a release changes semantics another replica must understand, including lease/fencing rules, node-registry meaning, control-event payloads, durable-job payloads, or persisted enum-like values.

### First upgrade to HA-3

Protocol-1 nodes can run alongside HA-3 nodes, but they do not implement the remote drain lifecycle. The drain API returns `409 Conflict` if asked to drain such a node. Upgrade those nodes one at a time with the existing graceful process shutdown. After every live node is HA-3 capable, use the drain API for subsequent rolling replacements.

### Migration compatibility

PostgreSQL migrations used during a rolling upgrade must remain safe for the previous supported release. Use an expand/migrate/contract sequence for renames or removals:

```text
N     add the replacement surface; keep the old one usable
N+1   move all supported code to the replacement
N+2   remove the old surface
```

`bun run check:schema-compat` checks PostgreSQL migrations after the pre-HA3 baseline. It rejects unapproved contractions such as dropped/renamed columns, required columns without defaults, type changes, removed defaults, and new uniqueness or integrity constraints.

An approved contraction must name the exact migration and surface in `backend/src/data/schema_contractions.json`, with release, owner, and justification metadata. Registering one surface does not exempt other changes in the same migration.

SQLite is not checked because HA does not support SQLite.

The same compatibility rule applies to persisted values and message payloads, not only SQL schema.

## Node draining

A planned drain has three phases:

```text
ACTIVE -> DRAINING -> DRAINED
```

When a node enters `DRAINING` it stops acquiring new local execution leases, durable jobs, assessment work, and coordinator scheduler work. Existing fenced Terraform/OpenTofu runs and durable jobs are allowed to finish.

Health assessments are coordinator-owned rather than independently leased. If the draining node is coordinator and an assessment is already running, it keeps the coordinator lease until that assessment finishes. It then resigns immediately instead of waiting for the normal coordinator lease timeout.

`DRAINED` means:

- no local run executions;
- no assessment execution or assessment claim in progress;
- no durable job or durable-job claim in progress;
- the node is not coordinator and is suspended from coordinator election.

A drained process remains alive but returns `DRAINING` readiness, so it should be out of the load-balancer pool before termination.

Drain intent is stored on the node row; the control event only reduces reaction time. A missed event is recovered from the persisted request. Reusing a node ID after it reaches `DRAINED` clears the old request and starts the replacement as `ACTIVE`.

A node can start cordoned with `TERRENCE_NODE_STATUS=draining` or `TERRENCE_NODE_STATUS=maintenance`.

System API:

```text
POST   /api/v1/nodes/:id/drain
GET    /api/v1/nodes/drain
DELETE /api/v1/nodes/:id/drain
```

`GET` reports the local node's phase and remaining run, assessment, and durable-job activity. `POST` may be sent to any HA-3 replica and targets the node ID in the path.

## Coordinator resignation

A planned drain does not wait for the 15-second coordinator TTL once coordinator-owned assessment work is clear. The node:

1. stops taking new scheduler work;
2. suspends itself from coordinator contention;
3. expires only the coordinator lease generation it owns;
4. continues observing the elected coordinator without trying to reclaim leadership.

Another eligible replica then acquires the lease through the normal PostgreSQL compare-and-set path. No successor is nominated.

## Rolling upgrade procedure

For HA-3-capable nodes:

1. deploy or start a compatible replacement where the topology permits it;
2. confirm `cluster-compatibility` readiness;
3. request drain on the old node;
4. wait for `DRAINED`;
5. terminate the old process;
6. start the replacement if it reuses the same node ID;
7. repeat for the remaining nodes.

For the initial upgrade from a pre-HA3 release, replace step 3 with graceful process shutdown because protocol-1 nodes do not implement remote drain.

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

Rolling-upgrade tests cover the compatibility window, coordinator resignation, startup cordons, execution-lease drain gating, health-assessment drain behavior, durable drain intent, and exact-surface schema contraction checks.

The PostgreSQL HA system test also exercises a real coordinator drain across multiple Terrence processes and verifies coordinator handoff, durable `DRAINED` state, readiness of the surviving replica, and reuse of the drained node ID by a replacement process.
