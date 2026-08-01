-- Keep JSON VCS references valid even when a reference write races deletion.
CREATE TRIGGER IF NOT EXISTS workspaces_vcs_repo_reference_check_insert
BEFORE INSERT ON workspaces
WHEN json_valid(NEW.vcs_repo) AND (
  (
    json_extract(NEW.vcs_repo, '$.githubAppInstallationId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM github_app_installations
      WHERE id = json_extract(NEW.vcs_repo, '$.githubAppInstallationId')
    )
  )
  OR (
    json_extract(NEW.vcs_repo, '$.oauthTokenId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM oauth_tokens
      INNER JOIN oauth_clients ON oauth_clients.id = oauth_tokens.oauth_client_id
      WHERE oauth_tokens.id = json_extract(NEW.vcs_repo, '$.oauthTokenId')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workspaces_vcs_repo_reference_check_update
BEFORE UPDATE OF vcs_repo, org_id ON workspaces
WHEN json_valid(NEW.vcs_repo) AND (
  (
    json_extract(NEW.vcs_repo, '$.githubAppInstallationId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM github_app_installations
      WHERE id = json_extract(NEW.vcs_repo, '$.githubAppInstallationId')
    )
  )
  OR (
    json_extract(NEW.vcs_repo, '$.oauthTokenId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM oauth_tokens
      INNER JOIN oauth_clients ON oauth_clients.id = oauth_tokens.oauth_client_id
      WHERE oauth_tokens.id = json_extract(NEW.vcs_repo, '$.oauthTokenId')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS policy_sets_vcs_repo_reference_check_insert
BEFORE INSERT ON policy_sets
WHEN json_valid(NEW.vcs_repo) AND (
  (
    json_extract(NEW.vcs_repo, '$.githubAppInstallationId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM github_app_installations
      WHERE id = json_extract(NEW.vcs_repo, '$.githubAppInstallationId')
    )
  )
  OR (
    json_extract(NEW.vcs_repo, '$.oauthTokenId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM oauth_tokens
      INNER JOIN oauth_clients ON oauth_clients.id = oauth_tokens.oauth_client_id
      WHERE oauth_tokens.id = json_extract(NEW.vcs_repo, '$.oauthTokenId')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS policy_sets_vcs_repo_reference_check_update
BEFORE UPDATE OF vcs_repo, org_id ON policy_sets
WHEN json_valid(NEW.vcs_repo) AND (
  (
    json_extract(NEW.vcs_repo, '$.githubAppInstallationId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM github_app_installations
      WHERE id = json_extract(NEW.vcs_repo, '$.githubAppInstallationId')
    )
  )
  OR (
    json_extract(NEW.vcs_repo, '$.oauthTokenId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM oauth_tokens
      INNER JOIN oauth_clients ON oauth_clients.id = oauth_tokens.oauth_client_id
      WHERE oauth_tokens.id = json_extract(NEW.vcs_repo, '$.oauthTokenId')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS github_app_installations_reference_check_delete
BEFORE DELETE ON github_app_installations
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE json_valid(vcs_repo)
    AND json_extract(vcs_repo, '$.githubAppInstallationId') = OLD.id
)
OR EXISTS (
  SELECT 1 FROM policy_sets
  WHERE json_valid(vcs_repo)
    AND json_extract(vcs_repo, '$.githubAppInstallationId') = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is still in use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS oauth_tokens_reference_check_delete
BEFORE DELETE ON oauth_tokens
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE json_valid(vcs_repo)
    AND json_extract(vcs_repo, '$.oauthTokenId') = OLD.id
)
OR EXISTS (
  SELECT 1 FROM policy_sets
  WHERE json_valid(vcs_repo)
    AND json_extract(vcs_repo, '$.oauthTokenId') = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is still in use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS oauth_clients_reference_check_delete
BEFORE DELETE ON oauth_clients
WHEN EXISTS (
  SELECT 1
  FROM workspaces
  INNER JOIN oauth_tokens ON oauth_tokens.id = json_extract(workspaces.vcs_repo, '$.oauthTokenId')
  WHERE json_valid(workspaces.vcs_repo)
    AND oauth_tokens.oauth_client_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM policy_sets
  INNER JOIN oauth_tokens ON oauth_tokens.id = json_extract(policy_sets.vcs_repo, '$.oauthTokenId')
  WHERE json_valid(policy_sets.vcs_repo)
    AND oauth_tokens.oauth_client_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'VCS integration reference is still in use');
END;
