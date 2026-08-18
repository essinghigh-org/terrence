---
title: Overview
category: Getting started
order: 10
description: What Terrence is, how it is deployed, and what this documentation covers.
---

# Overview

Terrence is a self-hosted Terraform backend. It provides the server side of the Terraform workflow: workspaces, remote runs, state storage, variables, policies, and a registry for modules and providers.

Terrence runs as a single container. The container holds the API server, the run executor, and the web interface. You deploy one instance and point Terraform at it.

## What Terrence does

- Stores Terraform state and serves it to CLI runs.
- Executes plans and applies on the server, not on your machine.
- Provides the `cloud` backend block and `terraform login` workflow.
- Manages workspaces, variables, variable sets, and projects.
- Runs policy checks, cost estimates, run tasks, and health assessments.
- Hosts a private module and provider registry.
- Connects to Git repositories so pushes trigger runs.
- Publishes a web interface for operators and teams.

## API compatibility

Terrence implements the Terraform Cloud API contract. The `terraform` CLI and tools written against that contract work without modification. The contract is stable: new endpoints are additive, and existing behavior never breaks.

## Architecture

Terrence is one process. It runs:

- An HTTP API server.
- A background worker that claims and executes runs.
- The web interface, served as static files from the same process.

The worker polls the run queue every 1.5 seconds by default. Auto-destroy scanning runs every 30 seconds. Health assessment discovery runs every 60 seconds. Each cadence is configurable.

Executions use Terraform or OpenTofu binaries that Terrence downloads and verifies. Server-side runs execute inside a Landlock sandbox. The sandbox restricts the run process to its own working directory and the binary directory. The sandbox is enabled by default; runs fail with a clear error when Landlock is unavailable and `TERRENCE_RUN_SANDBOX=false` is not set.

## Data storage

The default database is SQLite with WAL mode. PostgreSQL is supported for larger deployments. State archives and downloaded binaries live in the storage directory. See [Database](database) for details.

## Deployment

The container image is the deployment unit. It includes the API server, the worker, the web interface, and the documentation you are reading now. See [Configuration](configuration) for the environment variables that control the instance.

## The web interface

The web interface covers the same surfaces as the API:

- The dashboard lists organizations and recent runs.
- Workspace pages show runs, state versions, variables, and settings.
- Organization settings manage teams, users, variable sets, and integrations.
- Site administration manages users, organizations, workspaces, and versions.
- Documentation is bundled and served from the same application.

The interface respects a light and dark theme. Press Ctrl+K to open the command palette. The palette searches organizations, workspaces, actions, and these documentation pages.

## Concepts

If you are new to the Terraform server model, read [Core concepts](concepts) next. If you already know the model, start with [Quick start](quickstart).
