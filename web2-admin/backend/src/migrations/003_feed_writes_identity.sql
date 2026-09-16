-- web2-admin, checkpoint 3 step 2: make `feed_writes` the authority on the
-- feed's next index.
--
-- Why: the next index used to come from Bee's feed lookup — read the head,
-- write at head + 1. That lookup does not reflect an update the node itself
-- made until seconds later (~30 s measured on the test node), so two writes
-- 3-4 s apart both computed the same index and the second overwrote the
-- first. A feed update's chunk address is f(owner, topic, index), so nothing
-- complained; the earlier payload was simply gone. The same stale read also
-- handed the next publish a stale *payload*, which resurrected entries that
-- had just been unpublished, and made `unpublish` believe an entry was not on
-- the feed and skip its write.
--
-- `feed_writes` already held the true last index — it just could not say which
-- feed it belonged to, so a key rotation interleaved two index sequences in
-- one table. These three columns close that:
--
--   feed_owner  the feed key's address, hex without 0x, as it appears in bee's
--               /feeds/<owner>/<topic> URLs and in the entries themselves.
--   feed_topic  the hashed topic, the same hex those URLs carry.
--   reference   the chunk reference the node returned for that write, so a
--               write can be traced back to a chunk. NULL for a head this
--               backend adopted from the network at boot rather than wrote.
--
-- All three are nullable so this migration is forward-only and safe to run on
-- an existing database: rows written before it keep NULL, and every new query
-- filters on `feed_owner = $1 AND feed_topic = $2`, so those legacy rows are
-- invisible to the index lookup. On a database that only has legacy rows the
-- backend falls back to the network head for the first write after this
-- migration (and logs that it did); from the write after that, the log leads.
--
-- The partial unique index is the safety net the collisions slipped past: a
-- second write at an index already recorded for this feed now fails loudly
-- instead of silently replacing a chunk. It is partial so the legacy NULL rows
-- — which include the known duplicates at indices 22, 29 and 49 — do not block
-- the migration.

ALTER TABLE feed_writes
  ADD COLUMN feed_owner  TEXT,
  ADD COLUMN feed_topic  TEXT,
  ADD COLUMN reference   TEXT;

-- Also the lookup index: equality on (feed_owner, feed_topic) plus
-- ORDER BY feed_index DESC LIMIT 1 is exactly what `lastWrite` asks for.
CREATE UNIQUE INDEX feed_writes_feed_index_uniq
  ON feed_writes (feed_owner, feed_topic, feed_index)
  WHERE feed_owner IS NOT NULL;
