-- Deletes every account, sign-in, workspace and device link. The newsletter list is kept.
-- Relay data (agents, sessions, messages) lives in Durable Objects, not here: it is deleted by the
-- "v2" class migration in packages/cloud/wrangler.jsonc when that deploys.
--
--   cd packages/cloud && npx wrangler d1 execute a2a-accounts --remote --file ../../scripts/reset-accounts.sql
DELETE FROM auth_sessions;
DELETE FROM device_links;
DELETE FROM password_resets;
DELETE FROM account_relays;
DELETE FROM memberships;
DELETE FROM workspaces;
DELETE FROM users;
DELETE FROM auth_attempts;
