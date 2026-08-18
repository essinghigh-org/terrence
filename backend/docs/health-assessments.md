---
title: Health assessments
category: Workspaces and runs
order: 80
description: Periodic plan-only checks that record resource and check results.
---

# Health assessments

A health assessment plans a workspace without applying. The assessment detects drift and runs checks against the configuration.

## Enable assessments

Enable assessments per workspace in the workspace settings. Organizations can enforce assessments for all workspaces with `assessmentsEnforced`.

## Assessment cadence

The worker discovers due assessments every 60 seconds by default. The interval between assessments for one workspace is controlled by `HEALTH_ASSESSMENT_INTERVAL_MS`.

The discovery scan is separate from the run queue poll. Assessment execution uses its own concurrency limit, `HEALTH_ASSESSMENT_CONCURRENCY` (default 2). A workspace does not get a new assessment while one is pending or running, or while a run is active.

## What an assessment does

1. The worker takes the latest applied configuration.
2. It runs a plan against the current state in a fresh directory.
3. It parses the plan JSON and stores check results.
4. The assessment finishes with a status: completed, errored, or canceled.

Checks come from the plan JSON `checks` section. Each check is stored with its address, status, and message. The assessment also records whether the plan found drift.

## Results

Assessment results appear on the workspace page. Each result shows:

- The status.
- Pass, fail, and error counts for checks.
- The check details.
- The time the assessment ran.

## Restart behavior

If the Terrence process stops during an assessment, the running assessment moves to `errored` at startup. The next discovery cycle creates a fresh assessment.

## API surface

- `GET /api/v2/workspaces/:id/assessments`
- `GET /api/v2/assessment-results/:id`
- `GET /api/v2/assessment-results/:id/checks`
