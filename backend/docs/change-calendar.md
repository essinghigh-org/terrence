---
title: Change calendar
category: Workspaces and runs
order: 100
description: Schedule applies in advance and see them on a calendar.
---

# Change calendar

The change calendar shows scheduled applies over time. It is the planning surface for changes that must happen at a specific time.

## Schedule an apply

From the run page, confirm a run with a scheduled time. The run stays in `confirmed` until the time arrives.

The worker claims confirmed runs whose scheduled time has passed. The claim is atomic: overlapping polls cannot dispatch the same run twice.

## Calendar view

The calendar page shows runs grouped by their scheduled time:

- Upcoming applies.
- Past applies, shown as historical activity.

A run whose scheduled time passes without execution remains confirmed and is retried on the next poll.

## Blocked schedules

A scheduled apply can be blocked by site-wide gates:

- Maintenance mode.
- An approval workflow.

The run log records the block reason once per reason, not on every poll. The run stays confirmed and applies when the gate clears.

## Persistence

The schedule lives on the run row. A restart never loses a schedule: the apply poller is the single execution path and re-reads the schedule from the database.

## API surface

- `POST /api/v2/runs/:id/actions/schedule-apply`
- `GET /api/v2/organizations/:org_name/change-calendar` (range queries)
