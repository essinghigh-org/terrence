---
title: State
category: Workspaces and runs
order: 130
description: State versions, downloads, locks, and the state explorer.
---

# State

Terrence stores one state per workspace. State is versioned, locked, and downloadable.

## State versions

Every successful apply produces a state version. Each version records:

- The workspace.
- The serial number.
- The run that produced it.
- The payload.

State versions are immutable. The current version is the one Terraform uses for the next run.

Deferred uploads (create a pending version, then `PUT .../upload`) are claimed per version before the body transfers: a concurrent upload gets 409, and the finalize is an atomic conditional update with the output index rebuilt in the same transaction. `PUT .../json-upload` is likewise single-shot; `PUT .../json-outputs-upload` is single-shot on pending versions only and is rejected once set or finalized.

## State downloads

Download the current state or any historical version. The download endpoint issues a signed URL with a limited lifetime (`SIGNED_URL_TTL_SECONDS`).

State downloads are always recorded in the audit trail.

## State locking

Terraform locks the state during plans and applies. The lock prevents two runs from writing the same workspace. A run that cannot acquire the lock waits.

Workspace locks are separate. A manually locked workspace refuses new runs entirely. See [Workspaces](workspaces).

## State uploads

The CLI uploads state through the standard endpoints. Direct API uploads are also supported with a configuration version reference.

The worker downloads the latest finalized state before each plan so the run sees the current infrastructure.

## The state explorer

The explorer view shows a read-only summary of the current state:

- Workspaces and their latest state.
- Projects and tags.
- Latest runs.
- Resource counts.

Use the explorer for a fast inventory without querying every workspace.

## State history

The workspace page shows the state version history with serials and dates. Select a version to download or inspect it.

## Interrupted-apply recovery

Power loss mid-apply is the standard homelab failure mode. When the process restarts with a run stuck in `applying`, boot reconciliation copies the run's `terraform.tfstate` into `<storage>/recovery/<run-id>/` (atomically written, read-back verified, marked complete) and the run log tells you a copy was captured.

- `GET /api/v2/runs/:run_id/recovery-state` downloads the captured state (requires workspace admin). Returns 404 when no verified copy exists.
- `POST /api/v2/runs/:run_id/actions/recover-state` promotes the captured state into a new finalized state version (requires state-write permission plus holding the workspace lock). A successful recovery consumes the copy: it is deleted afterwards.
- The run page shows a Recover action whenever a verified copy exists.

Unrecovered copies are kept until they are recovered: they may be the only record of the infrastructure state, so they are never time-pruned. `TERRENCE_RECOVERY_RETENTION_MS` (default 7 days) now governs saved-plan expiry only.

## API surface

- `GET /api/v2/workspaces/:id/current-state-version`
- `GET /api/v2/workspaces/:id/state-versions`
- `GET /api/v2/state-versions/:id`
- `GET /api/v2/state-versions/:id/download`
- `POST /api/v2/workspaces/:id/state-versions`
- `PUT /api/v2/state-versions/:id/upload`
- `POST /api/v2/workspaces/:id/actions/lock`
- `POST /api/v2/workspaces/:id/actions/unlock`


## Deferred upload reservations

A pending reservation holds a serial for one hour and captures the workspace lock owner and acquisition time. Raw and derived uploads reject expired reservations or a changed lock. The final raw upload checks the declared serial, lineage and checksum again, fences the workspace row, and commits the bytes and output index together. Finalize records the SHA-256 of the committed bytes as the internal artifact identity; an identical retry compares against that digest (and backfills it on rows finalized before the column existed) without rewriting anything, while different bytes cannot replace the committed upload. Retry authorization and signed-URL expiry still apply. History listings exclude pending reservations; the direct show endpoint still serves a reservation to its uploader until it finalizes or is discarded.

Unlock and the next authorized state creation remove obsolete, uncommitted reservations. Explicitly deleting a pending version releases its serial immediately. Each removal records a transactional audit tombstone with its workspace, serial and reason. Committed state is not removed by this cleanup. Pending reservations created before this upgrade have a one-hour deadline derived from creation time; their original lock identity was not recorded and cannot be reconstructed.

## CLI state integrity checks

Run `bun test tests/api/state_cli_integrity.test.ts tests/api/state_cli_lifecycle.test.ts tests/api/state_serial_safety.test.ts` from `backend`. The standard SQLite and PostgreSQL CI suites include these tests. Both Terraform and OpenTofu inspect downloaded state after inline upload, deferred upload, rollback and recovery, then compute a local plan with refresh disabled. The fixture uses the built-in `terraform_data` resource and synthetic outputs; no apply or cloud provider is needed. Installed binaries are used when available, with the existing binary manager as fallback.

Checks compare serial, lineage, download checksum, indexed outputs and sensitivity, and verify that a stale API write cannot replace recovered state. This test covers API writes followed by local CLI reads and planning. The [pinned CLI matrix](cli-compatibility-results) separately covers basic remote-backend writes.

The `state_cli_lifecycle` suite closes the loop with engine-produced bytes: every state document comes from a real `terraform`/`tofu` apply (`terraform_data` plus synthetic outputs, one sensitive), so workspace lineage is engine-assigned and serials advance the way the engines advance them (replacement applies persist twice, which the suite tolerates by asserting advancement, never exact increments). It covers deferred reservation and upload of applied bytes with digest/serial/lineage agreement, rejection of a genuine second working directory's lineage with current state untouched, a second apply round-tripped through a clean `plan`, rollback-as-new-version and recovery promotion read back with `show -json` and `state pull`, intermediate upload promoted on unlock, and crash injection — a live loopback PUT whose body dies mid-stream stays pending, completes on retry with matching artifact identity, and never becomes current. Both engines run; both databases run through the standard SQLite and PostgreSQL CI suites.

## Client-encrypted OpenTofu state

Terrence does not support client-encrypted state as a managed state version. Inline and deferred uploads, state import, and agent completion reject OpenTofu encrypted envelopes with guidance. The worker's state journal also rejects them. Structured resource/output inspection and serial rewriting require plaintext v4 state; accepting an opaque JSON envelope would not establish those capabilities.

Do not enable OpenTofu state encryption in a Terrence remote workspace. A local worker that encounters encrypted state after apply marks the run errored and captures the original bytes for recovery; the infrastructure may already have changed. An agent's rejected completion retains its job claim so the rejection itself does not requeue apply. Preserve the agent work directory and resolve the state before resuming execution. These guards do not preflight every possible encryption configuration or external agent implementation.

An encrypted state version written by an older release remains downloadable unchanged, but advertises `state-representation: opentofu-encrypted`, `resources-processed: false` and a structured-view unavailability reason. Its outputs and JSON inspection endpoints reject the representation; rollback and recovery promotion cannot rewrite its serial. State history and run recovery explain that limitation. Downloading an encrypted copy does not validate its client key or change its representation.

A completed worker recovery capture can be downloaded without promotion. Markerless encrypted recovery files are retained for manual investigation because Terrence cannot verify them without client keys. Do not remove them as corrupt merely because plaintext inspection fails.

### Keys and recovery

OpenTofu client encryption is separate from Terrence's encryption of stored database columns and recovery files. HCP-compatible HYOK resources do not configure OpenTofu key providers or make client-encrypted state inspectable. Recovering a Terrence backup requires its server encryption material (`ENCRYPTION_PASSWORD` or `.encryption-key`, plus `.encryption-salt`). Reading an OpenTofu-encrypted file additionally requires its matching client key-provider configuration and key material; retain old keys while migrating. Keep keys in protected backup/key-management systems, never in general support bundles.

Use an encryption-capable backend when client-side encryption is required. Validate a downloaded copy in an isolated directory with the matching OpenTofu configuration and keys before continuing. Missing or wrong keys must fail; do not disable enforcement or silently migrate to plaintext to make an inspection feature work. Follow [OpenTofu's key rollover and recovery guidance](https://opentofu.org/docs/language/state/encryption/) for deliberate migration.

`tests/api/state_encryption_contract.test.ts` creates real encrypted state with the pinned current OpenTofu, checks correct/missing/wrong keys and key migration, verifies rejected writes leave current state intact, and proves downloaded encrypted recovery/legacy bytes can still be read and planned with the correct key.

## State history summaries

State commits persist a versioned metadata summary and output index in the same transaction as the canonical bytes. The summary generation includes their SHA-256 digest. Rollback and recovery compute both indexes from the promoted bytes after serial rewriting. Summaries contain counts, bounded engine/lineage metadata, size and checksums; they contain no resource attributes or output values.

Both state-version list endpoints select metadata without the raw state, JSON state or output payload columns. Detailed resources and output values are fetched through the individual version and output links. `summary-status` is `ready`, `opaque` or `invalid` for a current summary. Existing versions without summaries report `unindexed`; incompatible versions or digest mismatches report `outdated`. Unknown counts are null and `resources-processed` is false. These legacy rows remain available through the authenticated detail/download endpoints; listing does not rebuild them or enqueue work.

Run `STATE_SUMMARY_LOAD=1 bun test tests/api/run_state_history.test.ts` from `backend` to exercise a 20-version page backed by approximately 100 MiB of state. A local SQLite run returned 28,475 bytes in 48 ms; PostgreSQL 17 returned the same bytes in 5 ms. Observed JavaScript heap growth was zero in both samples, and PostgreSQL RSS increased by 256 KiB; SQLite RSS decreased as earlier allocations were collected. These single-process samples include authentication and serialization and are not peak-memory guarantees. The queries exclude payload columns, so application memory is bounded by page metadata rather than the stored payload sizes.
