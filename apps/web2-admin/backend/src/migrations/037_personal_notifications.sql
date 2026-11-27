-- Notifications for each user (docs/architecture/notifications.md). A notice
-- goes to people: each user saves where their own notices go and picks the
-- topics they get. What the brand shares is the service a notice goes out
-- through: the email service with its key and sender, and the Telegram bot.
--
-- The channels of migration 035 give way. Their email service, its key and
-- sender, and the Telegram bot's token carry over as the shared services. The
-- email recipients, the Telegram chat, the Slack channel and the notices that
-- waited for a channel go: each user enters their own destination on the
-- Notifications page.
--
-- An admin older than this migration reads `notification_channels`, which is
-- gone after it, so going back to one takes the database's backup.

-- A service a notice goes out through, shared by every user: a row from its
-- first save, which a user with the admin role makes.
--
--   kind                which service: 'email' or 'telegram'.
--   enabled             whether notices go out through it. It starts on.
--   settings            what the page shows of it, as JSON: for email the
--                       provider and the sender; for Telegram nothing.
--   secret_ciphertext   its secret, encrypted with AES-256-GCM: the email
--                       service's API key, or the Telegram bot's token.
--   secret_iv           the 12 random bytes this encryption used.
--   secret_auth_tag     GCM's 16-byte tag.
--   secret_key_version  which key it is encrypted under. Version 1 is derived
--                       from BRAND_WALLET_SECRET.
--   saved_at, saved_by  when it was last saved, and by whom.
--   last_sent_at        when it last took a notice, for any user. A test does
--                       not count.
--   last_failure        why the latest send through it failed, in a sentence
--                       that names no user and no destination: the service's
--                       status, or that no answer came.
--   last_failure_at     when that was.
CREATE TABLE notification_services (
  kind                TEXT PRIMARY KEY CHECK (kind IN ('email', 'telegram')),
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  settings            JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  secret_ciphertext   BYTEA NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 1 AND 512),
  secret_iv           BYTEA NOT NULL CHECK (octet_length(secret_iv) = 12),
  secret_auth_tag     BYTEA NOT NULL CHECK (octet_length(secret_auth_tag) = 16),
  secret_key_version  INTEGER NOT NULL CHECK (secret_key_version >= 1),
  saved_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by            TEXT NOT NULL CHECK (saved_by <> ''),
  last_sent_at        TIMESTAMPTZ NULL,
  last_failure        TEXT NULL,
  last_failure_at     TIMESTAMPTZ NULL,
  CONSTRAINT notification_services_failure_whole CHECK ((last_failure IS NULL) = (last_failure_at IS NULL))
);

-- The email channel and the Telegram channel become the two services, each
-- with its switch, who saved it and when it last took a notice. A secret
-- keeps its three sealed columns byte for byte and the label it was sealed
-- under, 'notification_channels:<kind>:v1', so it opens as before.
INSERT INTO notification_services (
  kind, enabled, settings, secret_ciphertext, secret_iv, secret_auth_tag, secret_key_version, saved_at, saved_by,
  last_sent_at
)
SELECT kind,
       enabled,
       CASE kind WHEN 'email' THEN settings - 'recipients' ELSE '{}'::jsonb END,
       secret_ciphertext,
       secret_iv,
       secret_auth_tag,
       secret_key_version,
       saved_at,
       saved_by,
       last_sent_at
  FROM notification_channels
 WHERE kind IN ('email', 'telegram');

DROP TABLE notification_deliveries;
DROP TABLE notification_channels;

-- Where one user's notices go on one service: their email address, or their
-- Telegram chat. A row from the user's first save, read and written by that
-- user alone, and gone with the user.
--
--   user_id          whose it is.
--   kind             the service it is reached through.
--   address          the email address, trimmed and in lower case, or the
--                    Telegram chat's id.
--   enabled          whether the user's notices go to it. It starts on.
--   saved_at         when the user last saved the address.
--   last_sent_at     when it last took a notice. A test does not count.
--   last_error       why its last notice could not be sent, null once one
--                    went out after it.
--   last_error_at    when that was.
--   last_test_at     when the user last sent a test notice to it. One goes
--                    out a minute at most.
--   last_test_error  why that test could not be sent, or null.
CREATE TABLE notification_destinations (
  user_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('email', 'telegram')),
  address          TEXT NOT NULL CHECK (address <> '' AND address = btrim(address) AND length(address) <= 254),
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  saved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at     TIMESTAMPTZ NULL,
  last_error       TEXT NULL,
  last_error_at    TIMESTAMPTZ NULL,
  last_test_at     TIMESTAMPTZ NULL,
  last_test_error  TEXT NULL,
  PRIMARY KEY (user_id, kind),
  CONSTRAINT notification_destinations_error_whole CHECK ((last_error IS NULL) = (last_error_at IS NULL)),
  CONSTRAINT notification_destinations_test_whole CHECK (last_test_error IS NULL OR last_test_at IS NOT NULL)
);

-- The topics one user gets notices of. A row from the user's first saved
-- destination, with the topics a user starts with, or from the user's first
-- save of the topics, whichever comes first. A user with no row gets none.
--
--   topics      the topics ticked, in the names of web2-admin-common's
--               NOTICE_TOPICS. A name the code no longer has is passed over.
--   updated_at  when the user last changed them.
CREATE TABLE notification_choices (
  user_id     UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  topics      TEXT[] NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The code a user sends to the Telegram bot from the chat their notices are to
-- go to, so that Find my chat can tell that chat from every other one that
-- wrote to the bot. A user has one at a time, and a new one replaces it.
--
--   code        ten characters drawn at random from capital letters and
--               digits, without the ones read for one another.
--   expires_at  until when it holds: ten minutes from when it was started.
CREATE TABLE notification_chat_codes (
  user_id     UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  code        TEXT NOT NULL CHECK (code ~ '^[A-HJKMNP-Z2-9]{10}$'),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- A notice that waits for a destination: one that held a part another
-- destination took and that this one could not take. It is tried again on
-- that destination until the destination takes it, until it is a day old, or
-- until nothing it tells of stands any more. It goes with its destination.
--
--   user_id, kind  the destination it waits for.
--   title, body    the notice as it was written for that user.
--   subjects       what it tells of, in the names of whoever raised it.
--   raised_at      when the notice was raised. A notice sent late says it.
--   attempts       how many times this destination was tried.
--   last_error     why the last try failed.
CREATE TABLE notification_deliveries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL CHECK (title <> ''),
  body        TEXT NOT NULL CHECK (body <> ''),
  subjects    TEXT[] NOT NULL,
  raised_at   TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_error  TEXT NOT NULL CHECK (last_error <> ''),
  CONSTRAINT notification_deliveries_destination_fkey
    FOREIGN KEY (user_id, kind) REFERENCES notification_destinations (user_id, kind) ON DELETE CASCADE
);

CREATE INDEX notification_deliveries_destination_idx ON notification_deliveries (user_id, kind, raised_at);

-- The stamps that are not marked for auto top-up and are running low
-- (docs/architecture/funding.md, "Stamps not on auto top-up"): one row from
-- the run that first reads an unmarked stamp under "Top up when under", with
-- time left, until it is topped up, marked or gone. The admin tops none of
-- them up: the rows are what the Auto top-up tab lists and what the notices
-- of the two "Stamps not on auto top-up" topics tell of.
--
--   batch_id        the stamp.
--   node_id         the node that holds it.
--   holder          which topic tells of it: 'catalogue' for the catalogue
--                   batch and the archive stamps, 'stage' for a stage's.
--   level           where it stands: 'low' under "Top up when under", 'last'
--                   under two days, 'expired' once it ran out or its node
--                   holds it no more.
--   since           when it was first read under "Top up when under".
--   level_since     when it reached its level.
--   message         what the tab and the notices say of it, as the last run
--                   worded it.
--   notified_level  the level the last notice that told of it named, or null
--                   while none did. A notice goes for each level once.
--   notified_at     when a notice last told of it, the daily one included,
--                   or null.
CREATE TABLE stamp_watch_notices (
  batch_id        TEXT PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
  node_id         TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  holder          TEXT NOT NULL CHECK (holder IN ('catalogue', 'stage')),
  level           TEXT NOT NULL CHECK (level IN ('low', 'last', 'expired')),
  since           TIMESTAMPTZ NOT NULL,
  level_since     TIMESTAMPTZ NOT NULL,
  message         TEXT NOT NULL CHECK (message <> ''),
  notified_level  TEXT NULL CHECK (notified_level IS NULL OR notified_level IN ('low', 'last', 'expired')),
  notified_at     TIMESTAMPTZ NULL,
  CONSTRAINT stamp_watch_notices_notified_whole CHECK ((notified_level IS NULL) = (notified_at IS NULL)),
  CONSTRAINT stamp_watch_notices_level_after_since CHECK (level_since >= since)
);
