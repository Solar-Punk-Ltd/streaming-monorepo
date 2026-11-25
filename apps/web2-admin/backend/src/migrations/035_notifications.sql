-- Notifications (docs/architecture/notifications.md): the channels the admin
-- sends its notices on, set on the Notifications page, and the notices that
-- wait for a channel. Stamp auto top-up's alerts and warnings go out on them,
-- so its own email list and the send state of its mail row, of migration 034,
-- give way.
--
-- A channel has a row from its first save, with its settings and its secret.
--
--   kind                which channel: 'email', 'slack' or 'telegram'.
--   enabled             whether notices go out on it. A channel starts on.
--   settings            what the page shows of it, as JSON: for email the
--                       service, the sender and the recipients; for Telegram
--                       the chat id; for Slack nothing.
--   secret_ciphertext   its secret, encrypted with AES-256-GCM: the email
--                       service's API key, Slack's webhook URL, Telegram's
--                       bot token.
--   secret_iv           the 12 random bytes this encryption used, drawn for it.
--   secret_auth_tag     GCM's 16-byte tag, which a wrong key or a changed byte
--                       of the other two fails.
--   secret_key_version  which key it is encrypted under. Version 1 is derived
--                       from BRAND_WALLET_SECRET, which never reaches the
--                       database.
--   saved_at, saved_by  when it was last saved, and by whom.
--   last_sent_at        when it last took a notice. A test does not count.
--   last_error          why its last notice could not be sent, null once one
--                       went out after it.
--   last_error_at       when that was.
--   last_test_at        when a test notice was last sent on it. One goes out
--                       a minute at most.
--   last_test_error     why that test could not be sent, or null.
CREATE TABLE notification_channels (
  kind                TEXT PRIMARY KEY CHECK (kind IN ('email', 'slack', 'telegram')),
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  settings            JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  secret_ciphertext   BYTEA NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 1 AND 512),
  secret_iv           BYTEA NOT NULL CHECK (octet_length(secret_iv) = 12),
  secret_auth_tag     BYTEA NOT NULL CHECK (octet_length(secret_auth_tag) = 16),
  secret_key_version  INTEGER NOT NULL CHECK (secret_key_version >= 1),
  saved_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by            TEXT NOT NULL CHECK (saved_by <> ''),
  last_sent_at        TIMESTAMPTZ NULL,
  last_error          TEXT NULL,
  last_error_at       TIMESTAMPTZ NULL,
  last_test_at        TIMESTAMPTZ NULL,
  last_test_error     TEXT NULL,
  CONSTRAINT notification_channels_error_whole CHECK ((last_error IS NULL) = (last_error_at IS NULL)),
  CONSTRAINT notification_channels_test_whole CHECK (last_test_error IS NULL OR last_test_at IS NOT NULL)
);

-- A notice that waits for a channel: one that another channel took and this
-- one could not. It is tried again on that channel until the channel takes
-- it, until it is a day old, or until nothing it tells of stands any more.
--
--   channel     the channel it waits for. It goes with the channel.
--   title, body the notice.
--   subjects    what it tells of, in the names of whoever raised it: for
--               stamp auto top-up a warning or a coming top-up.
--   raised_at   when the notice was raised. A notice sent late says it.
--   attempts    how many times this channel was tried.
--   last_error  why the last try failed.
CREATE TABLE notification_deliveries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel     TEXT NOT NULL REFERENCES notification_channels (kind) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (title <> ''),
  body        TEXT NOT NULL CHECK (body <> ''),
  subjects    TEXT[] NOT NULL,
  raised_at   TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_error  TEXT NOT NULL CHECK (last_error <> '')
);

CREATE INDEX notification_deliveries_channel_idx ON notification_deliveries (channel, raised_at);

-- Stamp auto top-up's notices go out on the channels. The email channel holds
-- the recipients, each channel holds how its last notice went, and what stays
-- with stamp auto top-up is when its two once-a-day notices last went out.
--
--   stamp_auto_topup_warnings.notified_at   when a notice last told of the
--                                           warning, or null.
--   stamp_auto_topup_notices.last_coming_at when the last "top-ups coming up"
--                                           notice went out.
--   stamp_auto_topup_notices.last_repeat_at when the standing warnings last
--                                           went out again together.
DROP TABLE stamp_auto_topup_emails;

ALTER TABLE stamp_auto_topup_warnings RENAME COLUMN mailed_at TO notified_at;

ALTER TABLE stamp_auto_topup_mail DROP CONSTRAINT stamp_auto_topup_mail_error_whole;
ALTER TABLE stamp_auto_topup_mail
  DROP COLUMN last_sent_at,
  DROP COLUMN last_error,
  DROP COLUMN last_error_at;
ALTER TABLE stamp_auto_topup_mail RENAME COLUMN last_coming_mail_at TO last_coming_at;
ALTER TABLE stamp_auto_topup_mail RENAME COLUMN last_repeat_mail_at TO last_repeat_at;
ALTER TABLE stamp_auto_topup_mail RENAME CONSTRAINT stamp_auto_topup_mail_pkey TO stamp_auto_topup_notices_pkey;
ALTER TABLE stamp_auto_topup_mail RENAME CONSTRAINT stamp_auto_topup_mail_id_check TO stamp_auto_topup_notices_id_check;
ALTER TABLE stamp_auto_topup_mail RENAME TO stamp_auto_topup_notices;
