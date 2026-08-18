---
title: Workspace tools
category: Administration
order: 65
description: Scorecards, activity views, and the permission simulator.
---

# Workspace tools

Several diagnostic surfaces help operators understand workspaces without opening each one.

## Workspace scorecards

The scorecard page ranks workspaces on operational signals:

- Run health.
- Configuration currency.
- Variable coverage.
- State freshness.

Each scorecard item explains the signal behind the score. Use the scorecards to find neglected workspaces.

## Workspace activity

The activity view lists recent workspace events: runs, state changes, and configuration changes. It answers "what changed lately" across an organization.

## Permission simulator

The permission simulator answers access questions without trial and error:

1. Pick a user.
2. Pick a resource: organization, project, workspace, or variable set.
3. The simulator shows the effective permissions.

The simulator evaluates the same permission logic the API uses.

## API surface

- `GET /api/v2/organizations/:org_name/workspace-scorecards`
- `GET /api/v2/workspaces/:workspace_id/activity`
- `POST /api/v2/organizations/:org_name/simulate-permissions`
