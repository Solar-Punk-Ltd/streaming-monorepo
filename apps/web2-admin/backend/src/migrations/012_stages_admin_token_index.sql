-- An uploader's call attributed by its token (docs/architecture/stages.md,
-- phase 5).
--
-- Every uploader presents a token to the uploader's routes under
-- /api/internal. A token that is not the shared INTERNAL_API_TOKEN is looked
-- up by its sha256 among the stages the manager pushed (migration 009): the
-- one active stage whose uploader presents a token of its own with that hash
-- is the caller, and the call is answered only about that stage's streams.
-- So migration 009's "Nothing reads them yet" no longer holds:
-- `admin_token_sha256` and `admin_token_kind` are read on every such call.
--
-- Only `own` rows are looked up. A `shared` row's hash is the shared token's,
-- which is compared with INTERNAL_API_TOKEN itself, so an old shared token the
-- admin no longer holds is not taken back through a stage row. A retired
-- stage's token is taken no more. The index covers exactly the rows the
-- lookup reads.
--
-- Not unique: two stages could be pushed with one token, a manager's mistake.
-- The admin refuses such a token rather than pick one of them, and says so in
-- its log; a unique index would refuse the second push instead, and keep a
-- stage's record out of the admin for a fault in its token.

CREATE INDEX stages_own_admin_token_idx ON stages (admin_token_sha256)
  WHERE admin_token_kind = 'own' AND retired_observed_at IS NULL;
