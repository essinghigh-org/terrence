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

GitHub App configuration is site-wide and is managed from **Site administration → GitHub App**. The connection card shows the current app, its source, and where its credentials are stored. Replacement, manual setup, environment recovery, and disconnect are grouped under **Advanced** rather than presented as competing primary actions.

Terrence offers three modes:

1. **Create automatically (recommended).** Choose the GitHub organization that should own the app, or leave it blank to use your personal account. The app is private to that account by default; explicitly allow other accounts to install it when needed. Terrence submits GitHub's App Manifest flow as a form POST with the homepage, setup callback, webhook URL, events, and required permissions already filled in. GitHub returns the App credentials to Terrence over the callback; the private key, webhook secret, and client secret are encrypted before they are persisted. The administrator then installs the new App on each required GitHub owner. Secrets are never shown in the browser.
2. **Use an existing GitHub App.** Supply the App ID, slug, private key, webhook secret, and optional Enterprise URLs in the site-admin form. Terrence calls `GET /app` before saving anything and rejects a key that does not belong to the claimed App.
3. **Environment configuration.** Kubernetes, Helm, and secret-manager deployments can continue to set the variables below. A complete environment configuration is validated against `GET /app` and imported once into encrypted storage at startup. Database configuration takes precedence after that import.

For an environment import, the four required values are:

| Environment variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | The GitHub App ID. |
| `GITHUB_APP_SLUG` | The app slug. |
| `GITHUB_APP_PRIVATE_KEY` | The app's RSA private key. |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret from the app settings. |
| `GITHUB_APP_HTTP_URL` | The GitHub HTTP URL. Defaults to `https://github.com`. |
| `GITHUB_APP_API_URL` | The GitHub API URL. Defaults to `https://api.github.com`. |

### Can I remove the environment variables?

The **Credentials saved in Terrence** message means the active private key and webhook secret can be read from encrypted database storage. At that point, you can remove `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` from the deployment. They are not needed again on restart. Removing them does not revoke the key on GitHub.

Keep the database and `STORAGE_DIR` persistent, including its encryption key/salt files, and retain `ENCRYPTION_PASSWORD` if it is configured. Losing the encryption material makes the stored credentials unreadable. Keep custom `GITHUB_APP_HTTP_URL` / `GITHUB_APP_API_URL` settings for future creation and import flows.

**Still using environment variables** means there is no persisted app configuration yet: do not remove the variables. An import label or a successful connection check alone is not evidence that the complete credentials have been stored. Invalid, incomplete, or undecryptable configurations do not display the removal recommendation.

The environment import is shown as **Imported from environment** (API source `legacy_environment_import`). Disconnecting the App removes the stored key and webhook secret, preserves workspace and repository configuration, and records that bootstrap was consumed. A restart with the same environment variables does not silently restore it; a site administrator must use the explicit environment recovery action. Invalid or revoked credentials are shown as connection-invalid and do not mint installation tokens.

### Replacement and recovery

The manifest replacement flow keeps the current App active until the replacement has passed JWT authentication, installation verification, repository enumeration, and permission checks. Existing installation records are remapped by GitHub owner name after every required owner has installed the replacement. Abandoning the manifest flow or missing an owner leaves the current App and workspace configuration untouched.

An unfinished registration displays **Continue installation on GitHub**. This issues a fresh installation state for the already-created app; it does not create another registration. A restart or expired setup link can require restarting registration before the credentials have been returned, but an app already saved as pending can be resumed. Successful setup returns to the GitHub App page.

The GitHub App registration link uses the verified account type to open organization or personal app settings. When the owner type cannot be verified, it opens the app's public page rather than guessing a personal settings URL. Terrence does not delete the registration because GitHub deletion uninstalls it everywhere. Removing an installation from Terrence and uninstalling that installation through GitHub are separate actions; uninstall never deletes the site-wide registration.

Environment import is an explicit recovery operation that overwrites the stored credentials and any pending setup. It requires confirmation and is only offered when a complete environment configuration is available. It does not migrate installations to a different app.

The VCS settings page lists the app installations. A workspace connects by choosing a repository from the installation.

The GitHub App uses org-level installation IDs. These IDs are stable and appear in workspace responses as `github-app-installation-id`.

### Manifest transport and browser policy

GitHub requires the JSON manifest in a form field named `manifest` on a POST to the registration endpoint; putting it in a GET query opens the ordinary, unpopulated app form. Terrence's authenticated setup API therefore returns a same-origin, single-use handoff URL. That document submits the form to GitHub and includes a manual button when JavaScript is disabled.

Only the handoff document permits form submission to the configured GitHub origin, with a nonce-authorized script, no caching, no referrer, and escaped field values. The rest of Terrence retains `form-action 'self'`; neither broad cross-origin form access nor a CORS proxy is required. Temporary states remain bound to the initiating administrator and are checked for revocation and expiry.

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
