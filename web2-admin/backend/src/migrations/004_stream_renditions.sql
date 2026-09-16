-- web2-admin, ABR ladder in admin mode: where the rungs live.
--
-- A stream published with ABR_ENABLED is not one manifest feed but five: a
-- master playlist on the stream's declared topic, and one rung feed per
-- rendition under a fresh random topic. swarm-hls-stream kept the merge state
-- of that ladder inside the catalogue feed itself, because standalone it is
-- the only writer of both. In admin mode it writes neither: this backend owns
-- the catalogue, so the ladder has to be stored somewhere it can rebuild an
-- entry from, and that is here.
--
-- One row per (stream, rung name), reported by the uploader through
-- POST /api/internal/streams/:id/renditions as a rung starts delivering and
-- again when it finalizes:
--
--   name              rung name, e.g. '720p'. Part of the primary key: a rung
--                     reports itself repeatedly (it retries, and it reconnects
--                     after a crash) and each report replaces the one row it
--                     owns. The charset matches the uploader's, where '_'
--                     separates the rung from the base in an ingest id and so
--                     cannot appear in a rung name.
--   width, height     the rung's geometry. `height` is also the ladder's sort
--                     order, hence the index below.
--   topic             the rung's own manifest feed, a UUID like streams.topic,
--                     signed by the same owner as the master.
--   bandwidth         peak segment bitrate, bits/s (HLS BANDWIDTH).
--   avg_bandwidth     mean bitrate, bits/s (HLS AVERAGE-BANDWIDTH). BIGINT for
--                     both: bits per second of a high rung is comfortably
--                     inside int4 today and nothing is gained by betting on it.
--   manifest_index    feed index of this rung's final VOD manifest, and
--   duration_seconds  how long it runs. Null until the rung finalizes, and set
--                     together — a ladder is finished when every rung has them,
--                     which is what tells the uploader to report `vod`.
--
-- ON DELETE CASCADE, plus an explicit delete in `finishUnpublish`: a row sent
-- back to `draft` has no ladder any more, and stale rungs would ride onto the
-- next entry it is published with.

CREATE TABLE stream_renditions (
  stream_id         UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  width             INT NOT NULL,
  height            INT NOT NULL,
  topic             UUID NOT NULL,
  bandwidth         BIGINT NOT NULL,
  avg_bandwidth     BIGINT NOT NULL,
  manifest_index    BIGINT,
  duration_seconds  DOUBLE PRECISION,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, name),
  -- The same rules the yup schema enforces at the edge, repeated here so no
  -- path can write a rung the master playlist cannot be built from.
  CONSTRAINT stream_renditions_name_format CHECK (name ~ '^[A-Za-z0-9.-]{1,32}$'),
  CONSTRAINT stream_renditions_width_positive CHECK (width > 0),
  CONSTRAINT stream_renditions_height_positive CHECK (height > 0),
  CONSTRAINT stream_renditions_bandwidth_non_negative CHECK (bandwidth >= 0),
  CONSTRAINT stream_renditions_avg_bandwidth_non_negative CHECK (avg_bandwidth >= 0),
  CONSTRAINT stream_renditions_manifest_index_non_negative
    CHECK (manifest_index IS NULL OR manifest_index >= 0),
  CONSTRAINT stream_renditions_duration_non_negative
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  -- Both or neither: "this rung is finished, and here is where" is one fact.
  CONSTRAINT stream_renditions_finished_together
    CHECK ((manifest_index IS NULL) = (duration_seconds IS NULL))
);

-- Every read is "the ladder of this stream, ascending by height".
CREATE INDEX stream_renditions_ladder_idx
  ON stream_renditions (stream_id, height);
