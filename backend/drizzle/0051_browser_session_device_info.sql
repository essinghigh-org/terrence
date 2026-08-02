-- Browser session device info: IP address and user-agent captured at login
-- time so the sessions list can show human-readable device details.
ALTER TABLE refresh_sessions ADD COLUMN ip_address TEXT;
--> statement-breakpoint
ALTER TABLE refresh_sessions ADD COLUMN user_agent TEXT;
