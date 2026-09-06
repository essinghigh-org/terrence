---
title: Product language
category: Getting started
order: 35
description: The words Terrence uses for runs, plans, state, recovery, and operator actions.
---

# Product language

Terrence uses a small, consistent vocabulary so that a status tells you what
happened and an action tells you what will happen next. API status values remain
available in diagnostics and integrations; the web interface uses the reader
labels below when the longer internal name would be ambiguous.

## Domain vocabulary

| Term | Meaning | Reader guidance |
|---|---|---|
| Workspace | A named execution boundary containing configuration, variables, runs, and state | Describe its purpose and the next workflow, not just its identifier |
| Configuration version | An immutable uploaded archive or VCS checkout used as run input | Say which version or commit a run used |
| Run | One execution of a workspace configuration | A run may plan, wait for approval, apply, or finish without changes |
| Plan | The proposed infrastructure changes produced by a run | A plan is a reviewable result; it is not an apply |
| Apply | The execution of an approved plan against the target infrastructure | Use “Apply this plan” when the action will start an apply |
| State version | An immutable recorded state snapshot | A state version describes recorded state, not guaranteed live infrastructure |
| Assessment | A plan-only health or drift check | An assessment does not change infrastructure |
| Policy check | A rule evaluation against a plan | A failed hard policy blocks apply; a soft failure needs an override |
| Agent | A registered execution worker for agent-mode workspaces | Explain when a run is waiting for agent capacity |
| Recovery | Evidence review and promotion of a recovered state snapshot | Promotion replaces recorded current state; it does not roll back infrastructure |

## Status words

Use these words precisely in banners, toasts, and action results:

- **Accepted** means the server validated and recorded a request.
- **Queued** means the request is recorded and waiting for a worker or
  scheduler; the work has not completed.
- **In progress** means execution has started but has not finished.
- **Completed** means the requested operation reached its terminal result.
- **Applied** means infrastructure changes were executed successfully.
- **Verified** means an independent check confirmed the result, such as a
  backup restore rehearsal or a readiness probe. Do not use it for an accepted
  or merely queued request.

## Action labels

Prefer labels that name the consequence:

| Avoid | Use |
|---|---|
| Submit | Create workspace, Queue plan, Save changes, or the specific action |
| Continue | Apply this plan, Review policy decision, or the next concrete step |
| Success | Queued, Plan complete, Applied successfully, or Verified |
| Roll back state | Promote this state as the new current version |
| Download | Download raw state, Download plan, or Download support bundle |

Cancellation, force-cancellation, discard, and delete are separate actions.
Their confirmation text should name what is retained and what is removed. A
retry message should identify the failed check and the next safe action without
implying that permission or infrastructure has changed.

See [Core concepts](concepts) for the object model and [Runs](runs) for the
complete lifecycle and action table.
