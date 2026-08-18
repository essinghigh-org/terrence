---
title: Comments
category: Workspaces and runs
order: 90
description: Discuss runs in place with run comments.
---

# Comments

Run comments let team members discuss a run in context. Comments are attached to a run and appear on the run page.

## Create a comment

Any user with access to the run can comment. The comment form is on the run page. Comments support plain text with basic formatting.

## Real-time delivery

New comments stream to open run pages in real time. The web interface subscribes to `comment.created` events over the server-sent events stream. No polling is involved.

## Comment metadata

Each comment records:

- The run it belongs to.
- The author.
- The creation time.
- The content.

Comments are permanent. There is no editing or deletion surface in the API.

## API surface

- `GET /api/v2/runs/:id/comments`
- `POST /api/v2/runs/:id/comments`

Run actions that create comments through the worker (apply, schedule, discard) record them the same way.
