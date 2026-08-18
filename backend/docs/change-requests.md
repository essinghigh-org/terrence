---
title: Change requests
category: Workspaces and runs
order: 110
description: Review and approve proposed changes before they apply.
---

# Change requests

A change request bundles proposed changes for review. It shows what will change and requires approval before the apply runs.

## Create a change request

Create a change request for a workspace. The request can carry proposed variables and a message. The workspace owner reviews the request in the web interface.

## Request lifecycle

| State | Meaning |
|---|---|
| Pending | Waiting for review. |
| Approved | Approved, apply can proceed. |
| Rejected | Rejected, no apply. |
| Applied | The change was applied. |

## Apply behavior

An approved change request creates a run that applies the proposed variables. The apply follows the normal run lifecycle. The change request page shows the run.

## Permissions

Creating and reviewing change requests uses the workspace permissions. The organization page lists all change requests.

## API surface

- `GET /api/v2/organizations/:org_name/change-requests`
- `POST /api/v2/organizations/:org_name/change-requests`
- `GET /api/v2/change-requests/:id`
- `PATCH /api/v2/change-requests/:id` (approve or reject)
