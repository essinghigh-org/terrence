---
title: Quick start
category: Getting started
order: 20
description: Bootstrap an instance, log in with the Terraform CLI, and run a first plan.
---

# Quick start

This guide takes you from an empty deployment to a completed plan. It assumes Terrence is already running and reachable over HTTPS. If it is not yet behind TLS, set that up first: [Reverse proxy (HTTPS)](reverse-proxy).

## Step 1: Create the first administrator

Terrence starts without any user accounts. Set the `ADMIN_PASSWORD` environment variable before the first start. On first boot, Terrence creates an administrator account with that password.

The administrator username defaults to `admin`. You can change it with `ADMIN_USERNAME`. The account email is set with `ADMIN_EMAIL`.

The bootstrap runs exactly once. Later restarts do not create or reset accounts.

Local registration is disabled by default. To allow anyone to register, set `TERRENCE_ENABLE_LOCAL_SIGNUP=true`. Registrations never become site administrators.

## Step 2: Log in with the CLI

Install Terraform on your machine. Then run:

```bash
terraform login terraform.example.com
```

Replace `terraform.example.com` with your instance hostname. The command opens a browser page on the instance. Sign in with the administrator account. The page shows an API token. Paste it into the terminal prompt.

Terraform stores the token in `~/.terraform.d/credentials.tfrc.json`. The CLI uses this token for every request.

## Step 3: Create an organization

Create an organization in the web interface, or with the API:

```bash
curl -X POST https://terraform.example.com/api/v2/organizations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{"data":{"type":"organizations","attributes":{"name":"example-org","email":"ops@example.com"}}}'
```

## Step 4: Create a workspace and run your first plan

Create a workspace:

```bash
curl -X POST https://terraform.example.com/api/v2/organizations/example-org/workspaces \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{"data":{"type":"workspaces","attributes":{"name":"my-first-workspace"}}}'
```

In a directory with a Terraform configuration, add a `cloud` block:

```hcl
terraform {
  cloud {
    hostname     = "terraform.example.com"
    organization = "example-org"
    workspaces {
      name = "my-first-workspace"
    }
  }
}
```

Run:

```bash
terraform init
terraform plan
```

The CLI uploads the configuration and the worker executes the plan on the server. Watch the run in the web interface under the workspace page.

## Step 5: Apply

Plans stop in the `planned` state and wait for confirmation. Confirm from the web interface, or with the API:

```bash
curl -X POST https://terraform.example.com/api/v2/runs/<run-id>/actions/apply \
  -H "Authorization: Bearer <token>"
```

Workspaces can enable auto-apply. With auto-apply enabled, a successful plan applies immediately.

## Next steps

- Read [Core concepts](concepts) to understand the run lifecycle.
- Read [Workspaces](workspaces) to configure execution modes and VCS connections.
- Read [Tokens](tokens) to mint tokens for automation.
- Read [Configuration](configuration) before running in production.
