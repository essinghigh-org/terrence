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

## Rolling upgrades and mixed versions

Terrence supports one version of skew — `N` alongside `N-1` — and deliberately not arbitrary skew.

Two versions are tracked because they change at different rates:

```text
application version   release identity (1.4.0, 1.5.1, ...)
HA protocol version   distributed semantics (leases, fencing, control
                      events, node registry, durable-job payloads)
```

Two releases that do not change distributed semantics share a protocol version and coexist freely:

```text
Terrence 1.5.1  HA_PROTOCOL=3   }  compatible
Terrence 1.5.0  HA_PROTOCOL=3   }

Terrence 2.0    HA_PROTOCOL=5   }  rejected
Terrence 1.5.0  HA_PROTOCOL=3   }
```

Each node advertises both the protocol it speaks and the oldest protocol it will serve alongside. Compatibility is the intersection of the two windows, so the joining node and the incumbents each hold a veto:

```text
compatible(a, b)  <=>  a.protocol >= b.minProtocol
                  and  b.protocol >= a.minProtocol
```

A replica whose version cannot interoperate with the live peers **refuses to start** rather than serving traffic in a half-supported skew. Only nodes with a fresh heartbeat are considered; a stale row describes a replica that has already been replaced and never blocks a rollout. Readiness exposes `cluster-compatibility`, `ha-protocol`, and `node-drain` checks so a rollout can be driven without querying the database.

Release-number skew outside the `N`/`N-1` window is reported but is advisory only. The protocol version is the contract: a release that genuinely breaks `N-1` must bump `HA_PROTOCOL_VERSION` rather than rely on its release number.

### Expand, migrate, contract

The rule every migration must satisfy:

> A migration shipped in N must never make an N-1 replica unsafe while N-1 remains within the supported rolling-upgrade window.

Adding a column, table, or index is safe — an old replica ignores what it does not know about. Removing or narrowing one is not, because an old replica is still reading and writing it. A rename is therefore three releases, not one:

```text
1.5  expand     add bar; old nodes read/write foo;
                new nodes understand foo + bar; backfill foo -> bar
1.6  migrate    all supported nodes use bar; nothing depends on foo
1.7  contract   drop foo
```

`bun run check:schema-compat` enforces this in CI. It rejects any contracting statement in a PostgreSQL migration that is not registered in `backend/src/data/schema_contractions.json` with the release that expanded the surface, the release the contraction is approved for, an owner, and why the window has passed. Contractions include the non-obvious ones: adding `NOT NULL`, dropping a default, and adding a unique index all break an `N-1` writer without deleting anything.

Only PostgreSQL migrations are checked. HA requires PostgreSQL; SQLite is a single-process backend where no second replica can observe the old shape.

The same discipline applies beyond columns — to enum-like status values, durable-job payloads, `control_events` topics and payloads, execution lease metadata, and serialized JSON fields. If `1.5` writes a run status that `1.4` does not recognise, HA is broken even though the database is perfectly available.

## Node draining

`draining` is a lifecycle, not a label:

```text
ACTIVE
   │  operator requests drain
   ▼
DRAINING
   ├─ resigns coordinator ownership immediately
   ├─ stops claiming durable jobs
   ├─ stops taking new local execution leases
   └─ allows existing run leases to finish
            │
            ▼
         DRAINED   (0 run executions, 0 durable jobs, not coordinator)
```

**Draining never kills a healthy Terraform or OpenTofu execution.** Because every run holds independent fenced ownership, a drain only has to stop acquisition:

```text
node-a: draining

run-123 token 47 -> still valid, runs to completion
run-456 token 12 -> still valid, runs to completion

new run-789:
    node-a refuses the claim
    node-b claims it
```

A run refused by a draining node is reported as ordinary contention, so it stays claimable by another replica instead of erroring. An in-flight plan may still proceed into its apply: automatic plan-to-apply reuses the live lease generation rather than acquiring a new one.

Once a node reports `DRAINED` it owns nothing and can be terminated safely.

Drain requests are durable. The request is recorded on the node row, so an operator's intent survives a missed `NOTIFY`, a restart, or a brief outage; a control event is only an accelerator. Draining is reversible, so an aborted rollout can return a node to service without a restart.

Drive it through the System API:

```text
POST   /api/v1/nodes/:id/drain     request a drain
GET    /api/v1/nodes/drain         poll this node's phase and remaining work
DELETE /api/v1/nodes/:id/drain     cancel (uncordon)
```

A node can also start cordoned with `TERRENCE_NODE_STATUS=draining`.

A replacement process that adopts a drained node's ID starts `ACTIVE`: the drain that retired the previous instance does not cordon its successor.

## Coordinator resignation

Failover by lease expiry is correct but costs up to the 15-second TTL, which is a pointless price during planned maintenance. A draining leader resigns instead:

```text
A epoch 41 leader, B follower, C follower

A enters drain
 ↓
A suspends contention
 ↓
A stops its scheduler generation
 ↓
A expires the coordinator lease (compare-and-set on owner + epoch)
 ↓
B claims epoch 42 immediately
```

The order matters: releasing the lease before stopping the scheduler would leave A generating work against a cluster that already has a new leader.

No successor is nominated. This is leader **resignation**, not leader transfer — A simply stops owning the PostgreSQL lease, and whichever eligible replica wins the ordinary atomic claim becomes leader. PostgreSQL remains the single coordination boundary; no second consensus mechanism is introduced.

A resigned node stays suspended until the drain is canceled, so its own next renewal tick cannot silently take leadership back. It keeps observing who leads, so the Operations Center still reports an accurate coordinator mid-drain.

## Rolling upgrade procedure

```text
              load balancer
             /      |      \
          A-old   B-old   C-old

deploy A-new
   ↓
A-new verifies protocol compatibility, joins as follower
   ↓
readiness succeeds
   ↓
drain A-old, wait for DRAINED
   ↓
terminate A-old

repeat for B, then C
```

If the coordinator is being drained, it resigns and a surviving replica is elected before the node finishes its remaining run leases. No outage, and no unnecessary Terraform cancellation.

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

Rolling-upgrade lifecycle tests verify:

- a draining node claims no new execution lease, while work it already owns runs to completion;
- an in-flight plan still proceeds into its apply on a draining node;
- a drain completes only once run executions, durable jobs, and coordinator ownership are all zero;
- a recorded drain request is adopted even if the control event never arrives, and canceling it uncordons the node;
- a resigning leader expires its own lease under a compare-and-set on owner and epoch, and does not reclaim it on the next tick;
- a node that never held the lease cannot expire someone else's ownership by resigning;
- an `N-1` peer is accepted, a peer outside the window is refused, and an incumbent peer can veto a newer joining node;
- a contracting migration fails CI unless it is registered with its justification.

The drain system test additionally starts real replicas and verifies that draining the elected coordinator hands off to a surviving replica with a higher epoch, that exactly one coordinator lease exists throughout, that the drained node converges to a durable `drained` status while still answering `/healthz` and reporting `DRAINING` readiness, that the surviving replica stays ready, and that a replacement process reusing the node ID returns `ACTIVE`.
