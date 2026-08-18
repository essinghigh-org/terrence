---
title: Authentication
category: Organizations and access
order: 60
description: Local accounts, OIDC, SAML, LDAP, and SCIM provisioning.
---

# Authentication

Terrence authenticates users locally or through external identity providers. The authentication settings live in the site administration area.

## Local accounts

Local accounts use a username and password. Passwords are hashed with bcrypt. Local signup is opt-in.

See [Users and account](users) for account management and multi-factor authentication.

## OIDC

Terrence acts as an OpenID Connect relying party:

1. Register Terrence in your identity provider.
2. Configure the provider in the OIDC settings page: issuer, client ID, client secret, scopes.
3. Sign-in offers the provider as an option.

The provider must be reachable from the server. The callback URL is `PUBLIC_URL/api/v2/oidc/callback` (or the configured callback path).

OIDC identities map to local user accounts. First sign-in creates the account and adds it to the default organization if configured.

## SAML

SAML service providers are configured in the SAML settings page:

- Identity provider metadata URL or XML.
- Certificate for signature verification.
- Attribute mappings.

The sign-in flow redirects to the identity provider and back to `PUBLIC_URL/api/v2/saml/callback`.

SAML and OIDC are alternatives. Only one may be active at a time.

## LDAP

LDAP directory integration authenticates users against an existing directory. Configuration includes the server URL, bind credentials, and the user search base.

LDAP users sign in with their directory credentials. Group membership can map to organization teams.

## SCIM

SCIM provisions users and groups from an identity provider:

1. Enable SCIM in the settings page.
2. Configure the bearer token.
3. Point the identity provider at the SCIM endpoint.
4. The provider creates users, teams, and memberships.

SCIM-managed teams are synchronized. Manual edits to those teams are refused. Users suspended in the identity provider are suspended in Terrence.

## Session controls

Organizations control session length and refresh. Site administration sets the global session policy.

## Sign-in flow

1. The user enters credentials or picks an external provider.
2. The server validates the credentials or completes the provider exchange.
3. Multi-factor authentication runs when the user has MFA enabled. The user submits a TOTP code.
4. The server issues a session token after MFA completes.

A user with MFA enabled receives no usable session until the TOTP code is verified.

Failed attempts are rate limited. See [Security](security).

## API surface

- `GET /api/v2/admin/auth` (current configuration)
- `POST /api/v2/oidc/authorize`
- `POST /api/v2/saml/authorize`
- `POST /api/v2/users/login`
- `POST /api/v2/users/login/mfa`
- `POST /api/v2/users/refresh`
- `POST /api/v2/signup`
- SCIM: `POST /scim/v2/Users`, `POST /scim/v2/Groups`
