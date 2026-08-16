---
title: Stacks
category: Workspaces and runs
order: 150
description: Link workspaces into stacks and manage them as a unit.
---

# Stacks

A stack groups workspaces that deploy together. Stacks give the stack a shared identity and a single management point.

## Create a stack

A stack belongs to an organization. Create it from the organization settings, under the stacks section.

## Stack members

Workspaces join a stack through the stack settings. A stack can hold workspaces from the same organization.

## What stacks provide

- A single list of the workspaces in the stack.
- Shared stack-level settings.
- A place to reason about the deployment as a whole.

Runs still execute per workspace. The stack does not change the run lifecycle.

## API surface

- `GET /api/v2/organizations/:org_name/stacks`
- `POST /api/v2/stacks`
- `GET /api/v2/stacks/:stack_id`
- `PATCH /api/v2/stacks/:stack_id`
- `DELETE /api/v2/stacks/:stack_id`
