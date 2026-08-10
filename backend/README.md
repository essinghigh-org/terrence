# backend

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Set `ENCRYPTION_PASSWORD` to a stable deployment secret to protect stored SSH
private keys. When it is omitted, Terrence creates a local key with owner-only
permissions at `STORAGE_DIR/.encryption-key`.

**Scope of at-rest protection:** the key encrypts SSH private keys at rest, so
a database-only leak (for example a copied `terrence.db`) does not expose the
keys. Because the key file sits beside the database on the same volume, it
does not protect against full-volume theft: an attacker who copies the whole
`STORAGE_DIR` volume also copies the key. To defend against volume theft,
supply `ENCRYPTION_PASSWORD` from a managed secret store or separate volume
instead of relying on the auto-generated key.

## Initial administrator

On a fresh database, set `ADMIN_PASSWORD` to create a local site administrator
at startup. The password must be at least 10 characters and must be changed
after the first login. `ADMIN_USERNAME` defaults to `admin`; `ADMIN_EMAIL` is
optional. The bootstrap user owns an organization named `default`; set
`ADMIN_ORGANIZATION` to choose another name. These variables are ignored once
any user exists.

For Terraform Enterprise-compatible automation, set `IACT_TOKEN` and send
`POST /admin/initial-admin-user?token=...` with `username`, `email`, and
`password`. The endpoint is available only while the user table is empty and
invalidates the configured token after the first successful request.

## System administration

Site administrators can run local health checks at `GET /api/v1/diagnostics`
and retrieve a privacy-limited workspace-count report at
`GET /api/v1/usage/bundle`.

The support bundle API is rooted at `/api/v1/support/bundle-requests`.
Generated gzip tarballs and request metadata persist in
`STORAGE_DIR/support-bundles` with owner-only permissions. Bundles contain
diagnostic results, the usage report, and build metadata only; they do not
include the database, environment variables, tokens, workspace variables,
state, configuration archives, or run logs. The hyphenated
`/api/v1/support-bundle-requests` path remains available as a compatibility
alias for the original project specification.

This project was created using `bun init` in bun v1.2.14. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
