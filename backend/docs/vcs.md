---
title: VCS integrations
category: Registry and VCS
order: 30
description: Connect Git repositories so pushes trigger runs.
---

# VCS integrations

VCS integrations connect Terrence to Git hosting. A connected workspace checks out its configuration from a repository. Pushes create runs automatically.

## Providers

Terrence supports these providers:

- GitHub and GitHub Enterprise, through a GitHub App.
- GitLab and GitLab Enterprise, through an OAuth client.
- Bitbucket, through an OAuth client.

## GitHub App setup

The GitHub App is the recommended path for GitHub:

1. Create a GitHub App in the GitHub organization settings.
2. Configure the app in Terrence:

| Environment variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | The GitHub App ID. |
| `GITHUB_APP_SLUG` | The app slug. |
| `GITHUB_APP_PRIVATE_KEY` | The app's RSA private key. |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret from the app settings. |
| `GITHUB_APP_HTTP_URL` | The GitHub HTTP URL. Defaults to `https://github.com`. |
| `GITHUB_APP_API_URL` | The GitHub API URL. Defaults to `https://api.github.com`. |

3. Register the webhook URL in the GitHub App: `PUBLIC_URL/api/webhooks/github`.
4. Install the app on the organizations that need workspaces.

The VCS settings page lists the app installations. A workspace connects by choosing a repository from the installation.

The GitHub App uses org-level installation IDs. These IDs are stable and appear in workspace responses as `github-app-installation-id`.

## OAuth clients

GitLab and Bitbucket use OAuth clients:

1. Create an OAuth client in the provider.
2. Add the client in the VCS settings page.
3. Authorize the connection.
4. Connect workspaces to repositories.

The callback URL is `PUBLIC_URL/api/v2/oauth-client/callback` (provider-specific path).

## Connect a workspace

In the workspace settings, choose the VCS provider and the repository. Workspace options:

- Branch. Defaults to the repository default branch.
- File triggers: only paths matching the trigger prefixes or patterns create runs.
  Prefix and pattern entries must be non-blank strings (rejected at save). Patterns are Bun globs matched against repository-relative paths with leading slashes stripped; patterns are OR-ed, and an empty pattern list falls back to prefix matching. A pattern that matches no changed files simply never triggers: dry-run saved patterns against the latest configuration with the trigger-preview endpoint.
- Ingress submodules: clone submodules.
- Tags regex: create runs for matching tags.

The stored repository reference appears as `vcs-repo` in the workspace API response, with kebab-case attribute names.

## Webhook behavior

Repository events are verified with the provider's signature before processing:

- GitHub: `x-hub-signature-256`.
- GitLab: `x-gitlab-token`.
- Bitbucket: `x-hub-signature`.

Push events create runs for connected workspaces when the changed files match the trigger rules. Pull request events create speculative plan-only runs. The run carries the VCS context: branch, commit, and PR number.

## VCS status reporting

Runs report their status back to the commit:

- The commit shows the run state (planned, applied, errored).
- Pull requests show the plan result.

The reporting uses the GitHub App or the OAuth connection.

## Webhook endpoints

| Provider | Endpoint |
|---|---|
| GitHub | `/api/webhooks/github` |
| GitLab | `/api/webhooks/gitlab` |
| Bitbucket | `/api/webhooks/bitbucket` |

All webhook endpoints verify signatures against the raw request body.
