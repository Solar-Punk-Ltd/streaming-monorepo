-- A manager from before the monorepo inserts a version without naming its
-- source, because it only ever builds from swarm-hls-stream. After 043 that
-- insert failed on the NOT NULL column, so a rollback to such a manager could not
-- add any version. A row inserted without a source can only come from such a
-- manager, so it is recorded as what it is. A manager from 043 on names the
-- source of every row it inserts, and never reaches this default.
ALTER TABLE stack_versions ALTER COLUMN source_url
  SET DEFAULT 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';
