---
title: Run tasks
category: Workspaces and runs
order: 60
description: Call external services before and after plans with run tasks.
---

# Run tasks

Run tasks integrate external services into the run lifecycle. A run task calls an external HTTP endpoint and records the response. External tools use run tasks for security scans, drift detection, or approval workflows.

## Task stages

| Stage | When it runs |
|---|---|
| Pre-plan | After the configuration is fetched, before the plan executes. |
| Post-plan | After the plan completes and policies pass, before the apply. |

Both stages are optional. A workspace can attach any number of tasks.

## How a task runs

1. The workspace attaches a run task with a URL.
2. The worker sends a request to the URL before or after the plan.
3. The external service responds with a status.
4. The worker records the result on the run.

The request includes run context so the service can fetch details from the API.

## Task results

A task result carries:

- The run task that produced it.
- The status: passed, failed, or errored.
- The external service response.
- The stage it ran in.

A mandatory pre-plan or post-plan task failure blocks the run. The run moves to `errored` with an explanation in the log.

## Timeouts

Each task has a timeout. The default is configurable through `RUN_TASK_TIMEOUT_MS`. A timed-out task counts as errored.

## Managing run tasks

Run tasks are managed from the workspace settings:

- Attach a task by name and URL.
- Set the stage.
- Enable or disable the task.
- Remove the task.

The run page shows which tasks ran and their results.

## API surface

- `GET /api/v2/workspaces/:id/run-tasks`
- `POST /api/v2/workspaces/:id/run-tasks`
- `PATCH /api/v2/workspaces/:id/run-tasks/:task_id`
- `DELETE /api/v2/workspaces/:id/run-tasks/:task_id`
- `GET /api/v2/run-tasks/:id/task-results`
