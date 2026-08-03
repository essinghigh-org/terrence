-- Keep external identity fields all-or-nothing without rebuilding users.
-- Some older installs receive unrelated users columns from the runtime
-- compatibility path rather than a journaled migration.
CREATE TRIGGER users_sso_identity_pair_insert
BEFORE INSERT ON users
WHEN (NEW.sso_provider IS NULL) != (NEW.sso_subject IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'sso_provider and sso_subject must be set together');
END;
--> statement-breakpoint
CREATE TRIGGER users_sso_identity_pair_update
BEFORE UPDATE OF sso_provider, sso_subject ON users
WHEN (NEW.sso_provider IS NULL) != (NEW.sso_subject IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'sso_provider and sso_subject must be set together');
END;
