-- The links a stream carries: other places the same broadcast can be watched,
-- such as its X and YouTube pages, or a page that goes with it.
--
-- A JSON array of { "label", "href" } objects, in the order the operator gave
-- them. The schema bounds it (at most four, each an https address) before it
-- is stored, so the column takes any array.
--
-- Every existing row starts with none. An entry is written with `links` only
-- when its stream has some, so no entry on the catalogue changes because of
-- this migration and a reconcile after it rewrites nothing.

ALTER TABLE streams
  ADD COLUMN links JSONB NOT NULL DEFAULT '[]'::jsonb;
