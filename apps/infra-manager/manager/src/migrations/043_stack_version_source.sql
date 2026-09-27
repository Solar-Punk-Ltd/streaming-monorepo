-- Where each version's stack comes from: the repository it is fetched from,
-- and the folder of that repository its current build took the stack from.
--
-- Every row that exists when this runs was built from swarm-hls-stream, whose
-- whole tree is the stack, so each is recorded that way and keeps building
-- from there. A version added from now on comes from the monorepo, where the
-- stack sits in apps/hls-stream, and a commit of the stack's own history from
-- before it moved there is built whole.
--
-- source_url is written when a row is inserted, because an update has to know
-- where to fetch from. source_folder describes the current build, like
-- commit_sha, so it stays NULL until a row's first build publishes and changes
-- only when a build publishes. Neither has a default: a row that forgot its
-- repository would build from whichever one a default happened to name.
--
-- The two checks are the build script's own rules on the same values: an
-- https GitHub clone address, and . or a relative folder of plain names.
ALTER TABLE stack_versions ADD COLUMN source_url TEXT;
ALTER TABLE stack_versions ADD COLUMN source_folder TEXT;

UPDATE stack_versions
   SET source_url = 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git',
       source_folder = '.';

ALTER TABLE stack_versions ALTER COLUMN source_url SET NOT NULL;

ALTER TABLE stack_versions ADD CONSTRAINT stack_versions_source_url_format
  CHECK (source_url ~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$');

ALTER TABLE stack_versions ADD CONSTRAINT stack_versions_source_folder_format
  CHECK (source_folder IS NULL OR (
    source_folder ~ '^(\.|[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*)$'
    AND position('..' in source_folder) = 0
  ));
