-- Stamp auto top-up: the marks of the Stamps tab, the settings of the Funding
-- page's Auto top-up tab, what the three timed jobs keep between their runs,
-- and the system as a requester in the two journals the jobs write through.
-- docs/architecture/funding.md, "Auto top-up", is the design, and
-- web2-admin-common's autoTopUp.ts names the shapes.
--
-- Going back to an older admin needs no step: it reads none of the new tables,
-- and a row it journals takes `requested_by_kind` 'operator' by its default.

-- Who asked for a send or a stamp operation: an operator, with their name in
-- `requested_by` and their id while the user exists, or this process on its
-- own account, with the reason in `requested_by`, 'stamp auto top-up', and no
-- user id.
ALTER TABLE funding_transfers
  ADD COLUMN requested_by_kind TEXT NOT NULL DEFAULT 'operator'
    CHECK (requested_by_kind IN ('operator', 'system'));
ALTER TABLE funding_transfers
  ADD CONSTRAINT funding_transfers_system_requester
    CHECK (requested_by_kind = 'operator' OR requested_by_user_id IS NULL);

ALTER TABLE funding_stamp_operations
  ADD COLUMN requested_by_kind TEXT NOT NULL DEFAULT 'operator'
    CHECK (requested_by_kind IN ('operator', 'system'));
ALTER TABLE funding_stamp_operations
  ADD CONSTRAINT funding_stamp_operations_system_requester
    CHECK (requested_by_kind = 'operator' OR requested_by_user_id IS NULL);

-- The wallet job sums what it sent in the last 24 hours and finds the nodes
-- it sent gas to; the stamp job finds a stamp's last automatic top-up.
CREATE INDEX funding_transfers_system_idx
  ON funding_transfers (created_at)
  WHERE requested_by_kind = 'system';
CREATE INDEX funding_stamp_operations_system_idx
  ON funding_stamp_operations (batch_id, created_at)
  WHERE requested_by_kind = 'system';

-- The numbers of the Auto top-up tab. One host, one row, as console_settings
-- (migration 021). No row means the defaults, AUTO_TOPUP_DEFAULTS, and the
-- bounds are AUTO_TOPUP_BOUNDS.
--
--   top_up_under_days   a marked stamp with less time left is due
--   top_up_to_days      the level a due stamp is topped up to
--   look_ahead_days     how long before a top-up falls due its alert goes out,
--                       and how long the wallet job waits after it
--   margin_percent      added to the cost in the alert and in the send
--   xdai_warning_wei    the brand wallet holding less xDAI is warned about
--   daily_ceiling_plur  the most xBZZ the wallet job sends in 24 hours, or
--                       null, and then it is half the monthly estimate
--   updated_by          the operator's username at the time
CREATE TABLE stamp_auto_topup_settings (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  top_up_under_days   INTEGER NOT NULL CHECK (top_up_under_days BETWEEN 2 AND 365),
  top_up_to_days      INTEGER NOT NULL CHECK (top_up_to_days BETWEEN 3 AND 730),
  look_ahead_days     INTEGER NOT NULL CHECK (look_ahead_days BETWEEN 1 AND 30),
  margin_percent      INTEGER NOT NULL CHECK (margin_percent BETWEEN 0 AND 100),
  xdai_warning_wei    NUMERIC(78, 0) NOT NULL CHECK (xdai_warning_wei >= 0),
  daily_ceiling_plur  NUMERIC(78, 0) NULL CHECK (daily_ceiling_plur IS NULL OR daily_ceiling_plur >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT NOT NULL CHECK (updated_by <> ''),
  CONSTRAINT stamp_auto_topup_settings_level_over_threshold CHECK (top_up_to_days > top_up_under_days),
  CONSTRAINT stamp_auto_topup_settings_floor_under_threshold CHECK (look_ahead_days * 2 <= top_up_under_days)
);

-- The three jobs: whether each is paused, and how its last run went. A paused
-- job is skipped by the tick and keeps the run before the pause.
CREATE TABLE stamp_auto_topup_jobs (
  job           TEXT PRIMARY KEY CHECK (job IN ('alert', 'wallet', 'stamp')),
  paused        BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at     TIMESTAMPTZ NULL,
  paused_by     TEXT NULL,
  last_run_at   TIMESTAMPTZ NULL,
  last_ok       BOOLEAN NULL,
  last_outcome  TEXT NULL,
  CONSTRAINT stamp_auto_topup_jobs_pause_named CHECK (
    (paused AND paused_at IS NOT NULL AND paused_by IS NOT NULL AND paused_by <> '')
    OR (NOT paused AND paused_at IS NULL AND paused_by IS NULL)
  ),
  CONSTRAINT stamp_auto_topup_jobs_run_whole CHECK (
    (last_run_at IS NULL AND last_ok IS NULL AND last_outcome IS NULL)
    OR (last_run_at IS NOT NULL AND last_ok IS NOT NULL AND last_outcome IS NOT NULL)
  )
);

INSERT INTO stamp_auto_topup_jobs (job) VALUES ('alert'), ('wallet'), ('stamp');

-- Who the alerts and warnings are mailed to: addresses trimmed and in lower
-- case, in the order of `position`.
CREATE TABLE stamp_auto_topup_emails (
  email     TEXT PRIMARY KEY CHECK (email = lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$' AND length(email) <= 254),
  position  INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by  TEXT NOT NULL CHECK (added_by <> '')
);

-- The marked stamps, one row each: taking a mark off deletes its row. The node
-- is the one that held the batch when it was marked, which pays for its
-- top-ups, and its label then.
--
-- The alert_* columns are the alert for the stamp's coming top-up, all null
-- while none is coming:
--   alert_days                   the whole days the top-up adds
--   alert_cost_plur              its cost when the alert was recorded
--   alert_cost_with_margin_plur  that cost plus the margin
--   alert_send_plur              the xBZZ the brand wallet sends its node for
--                                it, 0 when the node held enough
--   alert_gas_send               whether its node is sent gas with it
--   alert_recorded_at            when the alert job recorded it
--   alerted_at                   when it was handed to the mail service, or
--                                shown on the page with no mail set; null
--                                until then. The wallet job's wait counts
--                                from it.
--
--   unread_since  since when the stamp's node could not be read, or its chain
--                 view was behind, without a break; null while it reads well
CREATE TABLE stamp_auto_topup_marks (
  batch_id                     TEXT PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
  node_id                      TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  node_label                   TEXT NOT NULL CHECK (node_label <> ''),
  marked_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  marked_by                    TEXT NOT NULL CHECK (marked_by <> ''),
  alert_days                   INTEGER NULL CHECK (alert_days IS NULL OR alert_days >= 1),
  alert_cost_plur              NUMERIC(78, 0) NULL CHECK (alert_cost_plur IS NULL OR alert_cost_plur > 0),
  alert_cost_with_margin_plur  NUMERIC(78, 0) NULL,
  alert_send_plur              NUMERIC(78, 0) NULL CHECK (alert_send_plur IS NULL OR alert_send_plur >= 0),
  alert_gas_send               BOOLEAN NULL,
  alert_recorded_at            TIMESTAMPTZ NULL,
  alerted_at                   TIMESTAMPTZ NULL,
  unread_since                 TIMESTAMPTZ NULL,
  CONSTRAINT stamp_auto_topup_marks_alert_whole CHECK (
    (
      alert_days IS NULL AND alert_cost_plur IS NULL AND alert_cost_with_margin_plur IS NULL
      AND alert_send_plur IS NULL AND alert_gas_send IS NULL AND alert_recorded_at IS NULL AND alerted_at IS NULL
    )
    OR (
      alert_days IS NOT NULL AND alert_cost_plur IS NOT NULL AND alert_cost_with_margin_plur IS NOT NULL
      AND alert_send_plur IS NOT NULL AND alert_gas_send IS NOT NULL AND alert_recorded_at IS NOT NULL
      AND alert_cost_with_margin_plur >= alert_cost_plur
    )
  )
);

-- The warnings that stand: a row from the run that first sees the cause until
-- the run that sees it gone. `wallet_xbzz` and `wallet_xdai` are the brand
-- wallet's and name no stamp; `topup_failed` and `stamp_expired` name a marked
-- stamp, and go with its mark. `stamp_expired` is mailed once and stays until
-- the mark is taken off; the others are mailed again once a day.
--
--   since      when the cause was first seen
--   message    what the page and the mail say, as the last run worded it
--   mailed_at  when it was last mailed, or null
CREATE TABLE stamp_auto_topup_warnings (
  kind       TEXT NOT NULL CHECK (kind IN ('wallet_xbzz', 'wallet_xdai', 'topup_failed', 'stamp_expired')),
  batch_id   TEXT NULL REFERENCES stamp_auto_topup_marks (batch_id) ON DELETE CASCADE,
  since      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message    TEXT NOT NULL CHECK (message <> ''),
  mailed_at  TIMESTAMPTZ NULL,
  CONSTRAINT stamp_auto_topup_warnings_subject CHECK (
    (kind IN ('wallet_xbzz', 'wallet_xdai') AND batch_id IS NULL)
    OR (kind IN ('topup_failed', 'stamp_expired') AND batch_id IS NOT NULL)
  )
);

-- One warning of a kind for the brand wallet, and one of a kind for a stamp.
CREATE UNIQUE INDEX stamp_auto_topup_warnings_one_idx
  ON stamp_auto_topup_warnings (kind, COALESCE(batch_id, ''));

-- How mail went, one row, as the settings.
--
--   last_sent_at         when the mail service last took a mail
--   last_error           why the last mail could not be sent, null once one
--                        went out after it
--   last_error_at        when that was
--   last_coming_mail_at  when the last "top-ups coming up" mail went out; at
--                        most one goes out a day
--   last_repeat_mail_at  when the standing warnings were last mailed again
--                        together
CREATE TABLE stamp_auto_topup_mail (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_sent_at         TIMESTAMPTZ NULL,
  last_error           TEXT NULL,
  last_error_at        TIMESTAMPTZ NULL,
  last_coming_mail_at  TIMESTAMPTZ NULL,
  last_repeat_mail_at  TIMESTAMPTZ NULL,
  CONSTRAINT stamp_auto_topup_mail_error_whole CHECK ((last_error IS NULL) = (last_error_at IS NULL))
);

INSERT INTO stamp_auto_topup_mail DEFAULT VALUES;
