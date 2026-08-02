-- SSO identity tracking for SAML / OIDC / LDAP authentication.
-- sso_provider + sso_subject identify the external identity a user was
-- provisioned from. Local users keep both columns NULL. The unique index
-- guarantees an external identity maps to at most one local account.
ALTER TABLE users ADD COLUMN sso_provider TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN sso_subject TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX users_sso_identity_idx ON users (sso_provider, sso_subject);
