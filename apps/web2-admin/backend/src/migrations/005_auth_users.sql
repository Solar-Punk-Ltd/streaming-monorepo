-- Sign-in, second pass: roles, the sliding session clock, and no seeded user.
--
-- Ported from streaming-infra-manager's 008_auth.sql and 011_admin_users.sql.
-- What this backend already had (a users table, a sessions table holding only
-- the sha256 of the cookie value, and the self-describing
-- "scrypt$N$r$p$saltb64$hashb64" hash format) is unchanged, so every stored
-- password keeps verifying with the parameters it was written with.
--
-- is_admin: until now anyone signed in could do anything, which is fine for one
-- operator and wrong the moment there are two. The oldest user becomes the
-- admin, because that is the account the console was set up with; later users
-- are plain unless an admin says otherwise when adding them.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

-- Set before the CHECK below, so an existing install ends up with exactly one
-- admin whatever its usernames look like.
UPDATE users SET is_admin = true
 WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1);

-- When the account last signed in. The Access page shows it, and an account
-- that has never been used is the one worth asking about.
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;

-- Mirrors USERNAME_RE in web2-admin-common: 2 to 32 characters of a-z, 0-9,
-- dot, underscore or dash, starting with a letter or digit. Enforced here as
-- well as in the yup schema so no path can write a name the console cannot
-- render or the CLI cannot be asked for.
ALTER TABLE users
  ADD CONSTRAINT users_username_format
  CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$');

-- Sessions get the second of their two clocks. expires_at is the absolute
-- deadline written once at sign-in (14 days); last_seen_at is the sliding 12
-- hour idle limit, refreshed at most once a minute so an open console is not a
-- write per request. A session is over when the earlier of the two has passed.
--
-- Existing rows default to NOW(), which is the kindest reading: whoever is
-- signed in right now stays signed in.
ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Kept so a revoke can be told which browser it is dropping. Never used to
-- authenticate anything: a user agent is whatever the caller typed.
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;

CREATE INDEX sessions_last_seen_at_idx ON sessions (last_seen_at);
