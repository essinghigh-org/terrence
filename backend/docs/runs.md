---
title: Runs
category: Workspaces and runs
order: 20
description: The run lifecycle, every run status, and the operator actions available.
---

# Runs

A run is one execution of a workspace configuration. Runs are created by the CLI, by a VCS push, by the API, or by automation such as auto-destroy and health assessments.

## Run lifecycle

A normal run moves through these phases:

1. The run waits in `pending`.
2. The worker claims the run and fetches the configuration archive.
3. Pre-plan tasks run.
4. The plan executes.
5. Cost estimation runs if enabled.
6. Policy checks run if policies are attached.
7. Post-plan tasks run.
8. The run reaches a resting state.

From a resting state, the run either waits for confirmation or applies.

## Status table

| Status | Meaning | Resting |
|---|---|---|
| pending | Waiting in the queue | no |
| fetching | Downloading the configuration | no |
| fetching_completed | Configuration ready | no |
| pre_plan_running | Pre-plan tasks executing | no |
| pre_plan_completed | Pre-plan tasks finished | no |
| queuing | Preparing the plan | no |
| plan_queued | Plan dispatched | no |
| planning | Plan executing | no |
| planned | Plan finished, waits for confirmation | yes |
| cost_estimating | Cost estimate running | no |
| cost_estimated | Cost estimate finished | no |
| policy_checking | Policy checks running | no |
| policy_checked | Policy checks finished | no |
| policy_soft_failed | Soft-mandatory policy failed, override possible | yes |
| post_plan_running | Post-plan tasks executing | no |
| post_plan_completed | Post-plan tasks finished | no |
| planned_and_saved | Plan saved, waits for confirmation | yes |
| planned_and_finished | Plan only, no apply needed | yes |
| confirmed | Apply confirmed, waits for scheduling | yes |
| apply_queued | Apply dispatched | no |
| applying | Apply executing | no |
| applied | Apply finished | yes |
| errored | Run failed | yes |
| canceled | Operator canceled the run | yes |
| discarded | Run discarded | yes |
| force_canceled | Run force-canceled | yes |
| unreachable | Agent could not be reached | yes |

Resting states require an operator action or a scheduler. Non-resting states resolve on their own.

## Run types

- Normal run: plans and optionally applies.
- Plan-only run: plans without saving state. VCS pull requests and speculative runs use this type.
- Save-plan run: plans and saves the plan for later apply.
- Destroy run: plans and applies destruction. Auto-destroy creates these.

## Auto-apply

A workspace can enable auto-apply. With auto-apply enabled, a successful plan applies immediately. Auto-apply still respects the site-wide apply gates, such as maintenance mode and approval workflows.

A plan with no resource changes finishes as `planned_and_finished` without applying.

## Confirmation

Runs that need confirmation stop in `planned`, `planned_and_saved`, or `policy_soft_failed`. Confirm from the web interface or with `POST /api/v2/runs/:id/actions/apply`.

Runs can also be scheduled to apply at a later time. The worker persists the schedule and applies the confirmed run when its time arrives, including after a restart.

## Operator actions

| Action | Effect |
|---|---|
| Cancel | Stops a queued or running run. Safe to use. |
| Force-cancel | Cancels a run the worker may be executing. Use only when cancel does not work. |
| Discard | Discards a resting run. No apply happens. |
| Force-execute | Requeues a canceled run into `pending`. |
| Re-queue | Moves a queued run back to `pending`. |
| Apply | Confirms a resting run for apply. |
| Policy override | Allows a soft-failed run to proceed. |

## Concurrency

The worker claims a bounded number of runs per poll cycle. The default is 5 runs per cycle. One run per workspace executes at a time. Plan-only runs do not block other runs in the same workspace.

The queue scan is keyset-paged. A queue dominated by ineligible runs cannot hide newer eligible ones.

## Run tokens

Each run receives a short-lived credential at execution time. The credential is delivered through a private CLI configuration file inside the run directory. It is revoked when the run reaches a terminal state.

See [Tokens](tokens) for the details.

## Restart behavior

If the Terrence process stops during a run, the run is reconciled at startup:

- Pre-execution states (`fetching`, `queuing`, `plan_queued`) return to `pending`.
- States after pre-plan tasks began move to `errored`.
- An interrupted apply is never re-executed automatically. Infrastructure state is unknown.

The run log explains what happened. Agent-mode workspaces recover through agent heartbeats instead.

## Comments

Team members can comment on runs. Comments appear on the run page and stream to connected clients in real time. See [Comments](comments).
