-- The console's own settings for this host, today one: the look its console
-- starts in for a browser whose admin picked none of their own. An admin sets
-- it with `PUT /api/config/default-theme`, and
-- `GET /api/config` answers it to every console, the login page included.
--
-- One host, one row: `id` can only be true, as in brand_wallet (migration
-- 015). No row means the fallback look, DEFAULT_ADMIN_THEME in
-- web2-admin-common (Swarm since 2026-10-12).
--
--   default_theme  the look's name, as web2-admin-common's ADMIN_THEME_NAMES
--                  spells it. The API checks a new value against that list,
--                  and reads a stored name the console no longer carries as
--                  that fallback, so the list is deliberately not a CHECK here:
--                  retiring a look needs no migration.
--   updated_at     when it was last set, by the admin's clock.
--   updated_by     the admin's username at the time. The audit log's
--                  `console.theme.set` rows hold the history.
--
-- Going back to an older admin needs no step: it never reads the table.

CREATE TABLE console_settings (
  id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  default_theme  TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     TEXT NOT NULL CHECK (updated_by <> '')
);
