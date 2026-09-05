---
title: Workspaces
category: Workspaces and runs
order: 10
description: Create and configure workspaces: sources, execution modes, locking, and destruction.
---

# Workspaces

A workspace is the unit of Terraform execution. It owns a configuration source, variables, runs, and state.

## Create a workspace

Create a workspace from the web interface, the API, or the CLI. The minimum requirement is a name. Names must be unique within the organization.

Workspaces belong to a project. A workspace without a project lives at the organization level.

## Configuration source

A workspace gets its configuration from one of two places:

- Uploaded archive. The CLI uploads the configuration during `terraform plan` or `terraform apply`. The API can upload archives directly.
- Git repository. Connect the workspace to a repository in a VCS integration. Pushes to the repository create runs.

A VCS-connected workspace refuses applies from the CLI. The server executes the repository checkout instead. See [VCS integrations](vcs).

## Working directory

The working directory selects the subdirectory Terraform runs in. It must be a relative path without traversal, and — when the workspace has an uploaded configuration — it must match a directory in the latest configuration version; otherwise saving the workspace fails naming the available top-level entries. A directory that stops matching later (the configuration changed after saving) still fails at plan time with the directory named.

## Execution modes

Workspaces run in one of three modes:

- Remote. The Terrence worker executes the run inside the sandbox.
- Agent. An agent from a registered pool executes the run. Use this when runs must reach networks the server cannot.
- Local. The CLI executes the apply. The CLI must run with a user token that has apply permission for the workspace.

The mode is stored per workspace. See [Execution](execution) for the agent model and sandbox.

## Variables

Each workspace carries variables. Terraform variables feed the configuration. Environment variables are exported to the run process. Sensitive values are masked in API responses after creation.

See [Variables](variables) for the details.

## Runs and results

Runs appear on the workspace page. Each run produces a plan, and optionally an apply, policy results, cost estimates, and assessment results.

The workspace shows the current state version and the run history. Run logs stream in real time. The State History and Configuration Versions sections expose the timestamps and status of state and configuration changes, while run details expose the event timeline. Authorized organization and site administrators can review audit events through the audit log.

## Locking

Lock a workspace to prevent new runs. A locked workspace keeps existing runs but refuses new claims. Locks are manual and do not expire.

Workspace locks are separate from state locks. Terraform state locking still protects concurrent writes.

## Destroying workspaces

Deleting a workspace removes its runs, state versions, and variables. The operation requires the appropriate permission.

Workspace data deletion is irreversible. Export state before deleting a workspace you may need again.

## Auto-destroy

Workspaces can destroy themselves automatically:

- Scheduled: set an explicit destruction time.
- Inactivity: destroy after a period without activity.

Auto-destroy creates a destroy run with auto-apply enabled. The scan runs every 30 seconds by default. See [Auto-destroy](auto-destroy).

## Terraform version

Each workspace runs a specific Terraform or OpenTofu binary. The version is selectable at creation and can be changed later. Terrence downloads the binary on demand and verifies its checksum. See [Execution](execution).

## Tags

Workspaces accept tags. Tags filter workspaces in listings and can scope fine-grained token rules.
