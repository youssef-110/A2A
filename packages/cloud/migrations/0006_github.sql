-- GitHub sign-in: the GitHub account id an account is linked to.
ALTER TABLE users ADD COLUMN github_id TEXT;
CREATE UNIQUE INDEX users_github ON users (github_id);
-- Whether the email is proven (Google, GitHub or a reset email). Password sign-ups start unproven.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
