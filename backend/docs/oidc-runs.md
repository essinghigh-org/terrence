---
title: OIDC for runs
category: Workspaces and runs
order: 140
description: Issue OIDC tokens to runs for cloud provider authentication.
---

# OIDC for runs

Runs can authenticate to cloud providers with OIDC tokens. Terrence issues a token to the run process, and the provider's OIDC integration accepts it. This replaces long-lived cloud credentials in workspace variables.

## The flow

1. An organization configures OIDC settings for runs.
2. A run starts.
3. Terrence issues an OIDC token to the run process.
4. The provider authenticates the token against Terrence's issuer.

The token is short-lived and scoped to the run. Cloud credentials do not need to exist in the workspace variables.

## Configuration

Configure OIDC for runs in the organization settings, under the OIDC section:

- The issuer.
- The audience.
- Claim settings.
- Token lifetime.

The configuration is stored per organization. Workspaces in the organization inherit it.

## Provider setup

On the cloud provider side, register Terrence as an OIDC identity provider:

- Issuer URL: the instance's OIDC issuer.
- Audience: the audience configured in the organization.
- Subject: identifies the run.

Providers map the subject or claims to an IAM role. See the provider's OIDC documentation for the mapping format.

## Using the token

The token is available to the run process. Cloud providers fetch it through their OIDC integration. The exact configuration depends on the provider: web identity configuration, an IAM role, or an environment variable. See the provider's OIDC documentation for the setup steps.

## Permissions

Managing OIDC configurations requires the policy management permission at the organization level.

## API surface

- `GET /api/v2/organizations/:org_name/oidc-configurations`
- `POST /api/v2/organizations/:org_name/oidc-configurations`
- `PATCH /api/v2/oidc-configurations/:id`
- `DELETE /api/v2/oidc-configurations/:id`
