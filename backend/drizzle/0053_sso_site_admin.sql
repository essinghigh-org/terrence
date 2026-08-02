-- Track whether a user's site-admin flag is sourced from the SAML
-- site-admin attribute. Local admins (or admins granted through another
-- path) keep sso_site_admin = false, so a SAML login without the
-- site-admin attribute only demotes accounts whose admin status was
-- granted by SAML in the first place.
ALTER TABLE users ADD COLUMN sso_site_admin INTEGER NOT NULL DEFAULT 0;