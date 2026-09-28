import type { StageRecord } from '@streaming-monorepo/contracts';

/**
 * The manager pushes a stage record for every deployment that runs a stream
 * uploader into the web2 admin it is linked to, and retires it there when the
 * deployment goes. `docs/features/stages.md` in the manager is the page.
 *
 * Every push comes to one outcome code. The code is what the log and the
 * deployment page say, never what the admin answered, its address or a token.
 */
export const STAGE_PUSH_OUTCOMES = [
  /** The admin stored the record. */
  'stored',
  /** The admin holds a record read later than this one, and kept it. */
  'older-ignored',
  /** The admin retired the stage. */
  'retired',
  /** The admin had no such stage to retire. */
  'not-retired',
  /** The admin refused the link's token. */
  'refused-token',
  /** The admin refused the record itself, which a manager and an admin of different contract versions can do. */
  'refused-record',
  /** Nothing answered in time, or the answer stopped arriving. */
  'unreachable',
  /** The address answered with a redirect, which the manager does not follow. */
  'redirected',
  /** Something answered that is not a web2 admin taking stage records. */
  'not-admin',
  /** The manager has no web2 admin link, or its link stores no token. */
  'skipped-no-link',
  /** The deployment gives its uploader no web2 admin address. */
  'skipped-not-linked',
  /** The deployment's uploader reports to an admin on another origin than the manager's link. */
  'skipped-other-origin',
  /** The manager could not put the record together, for the reason its log line gives. */
  'skipped-no-record',
] as const;
export type StagePushOutcome = (typeof STAGE_PUSH_OUTCOMES)[number];

/** What each outcome is called on the deployment page. */
export const STAGE_PUSH_OUTCOME_TEXT: Readonly<Record<StagePushOutcome, string>> = {
  stored: 'registered',
  'older-ignored': 'the admin holds a newer reading',
  retired: 'retired',
  'not-retired': 'the admin had no such stage to retire',
  'refused-token': 'the admin refused the link’s token',
  'refused-record': 'the admin refused the record',
  unreachable: 'the admin did not answer',
  redirected: 'the admin’s address redirects, which the manager does not follow',
  'not-admin': 'the address did not answer as a web2 admin',
  'skipped-no-link': 'not pushed, the manager has no web2 admin link with a token',
  'skipped-not-linked': 'not pushed, the deployment is not linked to a web2 admin',
  'skipped-other-origin': 'not pushed, the deployment reports to another web2 admin than the manager’s link',
  'skipped-no-record': 'not pushed, the record could not be put together',
};

/** The last push of one deployment's record, as the manager keeps it in memory. */
export interface StagePushState {
  outcome: StagePushOutcome;
  /** When the push ended, ISO 8601. */
  at: string;
}

/** The ingest part of a record as the manager's own console is answered it: without the SRT passphrase. */
export type ConsoleStageIngest = Omit<StageRecord['ingest'], 'srtPassphrase'> & {
  /** Whether the record carries a passphrase, whose value this answer leaves out. */
  hasSrtPassphrase: boolean;
};

/** A record as `GET /stages` answers it. */
export type ConsoleStageRecord = Omit<StageRecord, 'ingest'> & { ingest: ConsoleStageIngest };

/** One deployment in `GET /stages`: the record the manager would push, and how its last push went. */
export interface ConsoleStage {
  name: string;
  /** Null when the record could not be put together, with the reason beside it. */
  record: ConsoleStageRecord | null;
  problem: string | null;
  lastPush: StagePushState | null;
}

/** What `GET /stages` answers. */
export interface ConsoleStagesAnswer {
  stages: ConsoleStage[];
}

/** What `GET /stages/:name/registration` answers: the deployment's last push, or null before any. */
export interface StageRegistrationAnswer {
  registration: StagePushState | null;
}

/** The page's line: what the last push came to and how long ago, in whole seconds. */
export function stageRegistrationLine(state: StagePushState | null, now: number): string {
  if (!state) return 'Web2 admin registration: not pushed yet';
  const seconds = Math.max(0, Math.round((now - Date.parse(state.at)) / 1000));
  return `Web2 admin registration: ${STAGE_PUSH_OUTCOME_TEXT[state.outcome]} ${seconds} s ago`;
}
