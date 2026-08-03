-- Provenance for SAML-managed memberships. Memberships created by the SAML
-- group mapper carry sso_source = 'saml'; admin-granted memberships keep it
-- NULL so SAML group pruning never touches them.
ALTER TABLE organization_memberships ADD COLUMN sso_source TEXT;
--> statement-breakpoint
ALTER TABLE team_memberships ADD COLUMN sso_source TEXT;