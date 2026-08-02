-- Fine-grained token scopes: JSON-encoded scope definition restricting what a
-- token can access (orgs, projects, workspaces, tags, permission bits).
-- NULL = legacy full-permission token (TFE compatibility preserved).
ALTER TABLE api_tokens ADD COLUMN scopes TEXT;
