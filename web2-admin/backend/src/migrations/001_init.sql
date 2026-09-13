-- web2-admin, checkpoint 2. Four tables, one per thing the admin layer owns.
--
-- users / sessions: msrs-client had no server-side login at all — an admin's
-- identity was a credential bundle decrypted in the browser, holding shared
-- server secrets and a Swarm private key. Here the password never leaves the
-- server: `password_hash` is node:crypto scrypt in the self-describing format
-- "scrypt$N$r$p$saltb64$hashb64" so the cost parameters can be raised later
-- without invalidating stored hashes. A session is a random 32-byte token in
-- an httpOnly cookie; only its sha256 is stored, so a database dump cannot be
-- replayed as a login.
--
-- streams: the draft. msrs-client minted the topic in the browser and wrote
-- straight to Swarm, so a failed write lost the stream and an orphaned
-- thumbnail stayed paid for. A row here is authoritative and editable before
-- and after it reaches the feed. `topic` is the stream id viewers use (uuid
-- v4) and `owner` is the feed key's address, denormalised onto the row so an
-- entry can be matched to its stream even if the backend's feed key is ever
-- rotated. `publish_key` is the per-stream credential that rides in the `key=`
-- query parameter of the ingest URL — 16 random bytes, rotatable, and
-- deliberately not the feed signing key (swarm-hls-stream's STREAM_KEY is an
-- Ethereum key and not an OBS credential). The thumbnail is stored as bytes
-- *and* as a Swarm reference: the bytes are the editable draft, the reference
-- is what a published feed entry points at, and it is cleared whenever the
-- image changes so publishing re-uploads it.
--
-- feed_writes: an append-only log of what this backend put on the stream list
-- feed and at which index. The feed is a single-writer structure and the
-- payload is the whole list rewritten each time, so when an index is ever in
-- doubt (a fork, a crash between the Swarm write and the status update) this
-- is the record of what we believe we wrote.

CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  password_changed_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the cookie value, hex. The cookie value itself is never stored.
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE streams (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic                   UUID NOT NULL UNIQUE,
  owner                   TEXT NOT NULL,
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL,
  tags                    TEXT[] NOT NULL DEFAULT '{}',
  media_type              TEXT NOT NULL,
  scheduled_start_time    TIMESTAMPTZ,
  thumbnail               BYTEA,
  thumbnail_mime          TEXT,
  thumbnail_ref           TEXT,
  status                  TEXT NOT NULL DEFAULT 'draft',
  published_at            TIMESTAMPTZ,
  published_feed_index    BIGINT,
  publish_error           TEXT,
  publish_key             TEXT NOT NULL,
  publish_key_rotated_at  TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The limits are also enforced by the yup schemas; they are repeated here so
  -- no path can write a row the frontend cannot render (msrs-client's limits).
  CONSTRAINT streams_title_length CHECK (length(title) BETWEEN 1 AND 100),
  CONSTRAINT streams_description_length CHECK (length(description) BETWEEN 1 AND 500),
  CONSTRAINT streams_media_type_known CHECK (media_type IN ('video', 'audio')),
  CONSTRAINT streams_status_known CHECK (
    status IN ('draft', 'publishing', 'published', 'live', 'vod')
  ),
  CONSTRAINT streams_publish_key_format CHECK (publish_key ~ '^[0-9a-f]{32}$')
);

CREATE INDEX streams_user_idx ON streams (user_id);
CREATE INDEX streams_status_idx ON streams (status);

CREATE TABLE feed_writes (
  id           BIGSERIAL PRIMARY KEY,
  feed_index   BIGINT NOT NULL,
  entry_count  INT NOT NULL,
  payload      JSONB NOT NULL,
  written_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX feed_writes_written_at_idx ON feed_writes (written_at DESC);
