---
title: Plan exports
category: Workspaces and runs
order: 145
description: Download a run's plan as a portable artifact.
---

# Plan exports

A plan export packages a run's plan into a downloadable artifact. Use exports for offline review, audit, or handoff.

## Create an export

Create an export for a run with a completed plan. The export is generated on demand.

## Download

The export page shows the download URL. The URL is a signed URL with a limited lifetime (`SIGNED_URL_TTL_SECONDS`).

An export can be downloaded more than once while the URL is valid.

## Permissions

Creating exports requires write access to the run's workspace. The export carries the same access rules as the plan itself.

## API surface

- `POST /api/v2/plan-exports`
- `GET /api/v2/plan-exports/:export_id`
- `GET /api/v2/plan-exports/:export_id/download`
