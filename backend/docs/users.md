---
title: Users and account
category: Organizations and access
order: 40
description: User accounts, sessions, passwords, and multi-factor authentication.
---

# Users and account

Users authenticate to Terrence with a username and password, or through an external identity provider. Each user has an account page with profile, appearance, sessions, security, and token settings.

## Create a user

Users are created in three ways:

- Registration. Enabled with `TERRENCE_ENABLE_LOCAL_SIGNUP=true`.
- Site administration. The admin users page creates accounts.
- External identity providers. OIDC, SAML, and SCIM provision accounts.

Registered users never become site administrators.

## The first administrator

The first administrator comes from the bootstrap flow. Set `ADMIN_PASSWORD` before first start. The bootstrap runs under an exclusive lock, so concurrent first starts cannot create two admins.

See [Quick start](quickstart).

## Account page

The account page has these sections:

- Profile: username, email, avatar.
- Appearance: light or dark theme.
- Sessions: active sessions, session revocation.
- Password: change your password.
- Security: multi-factor authentication.
- API tokens: create, list, and revoke tokens.

## Passwords

Password requirements are enforced centrally:

- Minimum length, configurable with `TERRENCE_PASSWORD_MIN_LENGTH`.
- The password policy can require complexity.

Site administrators can force a password change. A forced password change blocks other account functions until the password is updated.

## Multi-factor authentication

Terrence supports TOTP-based multi-factor authentication:

1. Enable MFA in the security section. Terrence shows a TOTP secret and a QR code.
2. Register the secret in an authenticator app.
3. Confirm with a code.
4. Sign-in then requires the TOTP code.

Disabling MFA requires a valid TOTP code. Users with MFA enabled must present a code at every login.

## Sessions

Sessions are tracked per user. The sessions section lists active sessions with their creation time and last use. Revoke any session from the list.

Session duration is controlled by the organization's session settings and by instance settings. Sessions refresh transparently while active.

## Suspension

Site administrators can suspend a user. A suspended user cannot authenticate. Their open event streams close immediately.

## Account deletion

Site administrators delete user accounts. The user row, tokens, and sessions are removed.

## API surface

- `GET /api/v2/account/details`
- `PATCH /api/v2/account/details`
- `GET /api/v2/users/:id/authentication-tokens`
- `POST /api/v2/users/:id/authentication-tokens`
- `POST /api/v2/users/:id/actions/suspend`
- `POST /api/v2/users/:id/actions/unsuspend`
