---
title: Auto-destroy
category: Workspaces and runs
order: 120
description: Destroy workspaces automatically by schedule or by inactivity.
---

# Auto-destroy

Auto-destroy removes a workspace's infrastructure without manual action. Two triggers exist:

- Scheduled destruction at an explicit time.
- Inactivity destruction after a quiet period.

## How it works

The worker scans for due auto-destroy targets every 30 seconds by default. The cadence is set with `TERRENCE_AUTO_DESTROY_POLL_MS`.

When a workspace is due, the worker creates a destroy run with auto-apply enabled. The run uses the latest configuration version. The destroy then runs through the normal lifecycle.

A workspace with an active run is not eligible. A locked workspace is not eligible.

## Scheduled destruction

Set `autoDestroyAt` on the workspace. When the time arrives, the workspace schedules a destroy run and clears the scheduled time.

## Inactivity destruction

Set an activity duration on the workspace. Activity is measured from:

- Workspace creation time.
- The latest finalized state version.
- The latest auto-destroy attempt.

When the quiet period passes, the workspace schedules a destroy run. Activity after that resets the clock.

## The scan

The auto-destroy scan reads all workspaces, runs, finalized state versions, and configuration versions. It runs on its own cadence so the fast queue poll never pays for this scan.

## API surface

- `PATCH /api/v2/workspaces/:id` with `auto-destroy-at` or `auto-destroy-activity-duration`.
- `DELETE /api/v2/workspaces/:id/actions/auto-destroy-schedule`
