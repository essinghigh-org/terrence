---
title: Core concepts
category: Getting started
order: 30
description: The object model: organizations, projects, workspaces, runs, state, and tokens.
---

# Core concepts

This page explains the objects Terrence manages and how they relate. The model matches the Terraform cloud API, so existing Terraform knowledge transfers directly.

## Organizations

An organization is the top-level tenant. It owns workspaces, projects, variable sets, teams, and registry entries. Users join organizations through memberships. Membership carries a role: owner, member, or a custom role.

Each organization has its own settings: name, email, session controls, IP allowlists, and service provider configuration.

## Projects

A project groups workspaces inside an organization. A workspace belongs to exactly one project, or to none. Projects exist to organize workspaces and to apply settings to a group.

Workspaces without a project live at the organization level. Deleting a project moves its workspaces back to the organization level, unless the project is deleted with the option to delete its workspaces too.

## Workspaces

A workspace is the unit of Terraform execution. It owns:

- A configuration source (uploaded archive or a Git repository).
- Variables.
- Runs.
- State versions.
- Run results: plans, applies, policies, cost estimates, assessments.

A workspace runs in one of three execution modes:

- Remote. The Terrence worker executes runs.
- Agent. A registered agent executes runs.
- Local. The CLI executes the apply and uploads the result.

See [Workspaces](workspaces) for details.

## Runs

A run is one execution of the workspace configuration. The run lifecycle is:

1. `pending`: the run waits in the queue.
2. The worker claims the run and fetches the configuration.
3. Pre-plan tasks run.
4. The plan executes.
5. Cost estimation and policy checks run.
6. Post-plan tasks run.
7. The run reaches `planned`, `planned_and_saved`, or `planned_and_finished`.
8. For applies: the run moves to `confirmed` (or `apply_queued` directly), then `applying`, then `applied`.

A scheduled apply waits in `confirmed` until its time arrives. Every state change is recorded with a timestamp. A run that fails moves to `errored`. Operators can cancel, discard, or force-cancel runs. See [Runs](runs) for the full state table.

## State

State is stored per workspace. Each successful apply produces a state version. State versions are immutable and versioned. Older versions remain available for rollback.

Terraform runs read and write state through the server. A lock prevents two runs from writing the same workspace at the same time.

## Configuration versions

Each run references a configuration version. A configuration version is a snapshot of the workspace configuration:

- An uploaded archive from the CLI or API.
- A checkout from a Git repository at a specific commit.

Terrence stores the archive and extracts it into a fresh directory for each run.

## Variables and variable sets

Workspace variables supply values to runs. They come in two categories:

- Terraform variables: input variables for the configuration.
- Environment variables: exported to the run process.

Variable sets apply the same variables to many workspaces at once. See [Variables](variables) and [Variable sets](variable-sets).

## Plans and plan output

Every run produces a plan. Terrence stores the plan artifact and the plan JSON output. The API serves the structured plan so tools can inspect resource changes.

Plan resource counts are stored on the run: additions, changes, destructions, and imports.

## Policy checks

Policy sets attach to organizations, projects, or workspaces. After a plan, the worker evaluates the policy sets against the plan. A policy failure can block the apply. See [Policies](policies).

## Run tasks

Run tasks call external services at two points: before the plan and after the plan. The external service responds with a status that Terrence records. See [Run tasks](run-tasks).

## Health assessments

A workspace can run periodic health assessments. An assessment plans the workspace state without applying and records check results. See [Health assessments](health-assessments).

## Tokens

Terrence uses tokens for authentication:

- User tokens authenticate the CLI and API calls.
- Organization tokens and team tokens authenticate automation.
- Run tokens are short-lived credentials minted per run.
- Fine-grained tokens restrict access to specific resources.

See [Tokens](tokens) and the [Security](security) guide.

## Events

The API exposes a server-sent events stream at `/api/v2/events`. The stream delivers run status changes, plan readiness, and comment events in real time. The web interface uses the stream instead of polling. See the [API reference](api).
