import {
  type ConsoleStage,
  type ConsoleStageIngest,
  type ConsoleStageRecord,
  formatDateTime,
  isTransitional,
  NO_VALUE,
  shortHex,
  STAGE_PUSH_OUTCOME_TEXT,
  type StagePushOutcome,
  type StagePushState,
  statusLabelOf,
} from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import { ROTATE_ADMIN_TOKEN_LABEL } from '../deployments/stageText';

/**
 * What the Stages page says about each stage: the record the manager would push into the web2 admin now, as
 * `GET /stages` answers it, and how its last push went. The page renders what these return, so the tests read what
 * the operator reads.
 */

/** How often the page reads the stages again: the cadence the manager pushes a running stage on. */
export const STAGES_REFRESH_MS = 30_000;

export const STAGES_LEAD = `Every deployment that runs a stream uploader is a stage of the web2 admin. Each row is the record the manager would push there now, built afresh, and how its last push went. Read again every ${STAGES_REFRESH_MS / 1000} seconds.`;

export const STAGES_NONE = 'This manager runs no stage.';
export const STAGES_NONE_HINT =
  'A stage is a deployment that runs a stream uploader: a stream, or an ABR uploader in front of a node pool. The manager pushes its record into the web2 admin its link names.';

/** Said for a stage whose record came back without a reason, which the manager does not answer. */
export const STAGE_NO_RECORD = 'The manager could not put this stage’s record together.';

const KIND_LABEL: Readonly<Record<ConsoleStageRecord['kind'], string>> = {
  streamer: 'Stream',
  'abr-uploader': 'ABR uploader',
};

const ENGINE_LABEL: Readonly<Record<ConsoleStageRecord['engine'], string>> = {
  srs: 'SRS',
  ome: 'OvenMediaEngine',
};

/** What the stage is, under its name: its kind, its engine and, when it has one, its stack version. */
export function kindLine(record: Pick<ConsoleStageRecord, 'kind' | 'engine' | 'stackVersion'>): string {
  return [
    KIND_LABEL[record.kind],
    ENGINE_LABEL[record.engine],
    record.stackVersion ? `stack ${record.stackVersion}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface StatusView {
  label: string;
  tone: Tone;
  pulsing: boolean;
}

/** The deployment's status on the record, in the words and tone every row of the console gives it. */
export function statusView(status: string): StatusView {
  const { label, tone } = statusLabelOf({ status });
  return { label, tone, pulsing: isTransitional({ status }) };
}

export interface ReadinessView {
  label: string;
  tone: Tone;
  reasons: string[];
}

/**
 * The record's verdict in the four words the web2 admin shows it in, on the console's tones. `blocked` is red, as it
 * is there: the record no longer tells a step that is off from one that refuses.
 */
const READINESS_VIEW: Readonly<Record<ConsoleStageRecord['readiness']['tone'], { label: string; tone: Tone }>> = {
  ready: { label: 'Ready', tone: 'ok' },
  warning: { label: 'Warning', tone: 'warn' },
  blocked: { label: 'Blocked', tone: 'err' },
  unknown: { label: 'Unknown', tone: 'info' },
};

/** The verdict and every reason the manager gave for it, in its order, so the first is the console's own label. */
export function readinessView(readiness: ConsoleStageRecord['readiness']): ReadinessView {
  return { ...READINESS_VIEW[readiness.tone], reasons: readiness.reasons };
}

export interface OwnerView {
  address: string;
  short: string;
}

/** The address the stage's feeds are signed as, shortened for the table and whole for the copy. */
export function ownerView(owner: string): OwnerView {
  return { address: owner, short: shortHex(owner) };
}

export interface IngestView {
  host: string;
  ports: string;
}

/** Where encoders send the stage's streams: the host, then each port and what goes with it. */
export function ingestView(ingest: ConsoleStageIngest): IngestView {
  const srt = `SRT ${ingest.srtPort}, ${ingest.hasSrtPassphrase ? 'with a passphrase' : 'no passphrase'}`;
  const rtmp = ingest.rtmpPublic ? `RTMP ${ingest.rtmpPort}, unencrypted` : 'RTMP not offered';
  return { host: ingest.host, ports: `${srt} · ${rtmp}` };
}

export interface TokenView {
  label: string;
  tone: Tone;
  /** What to do about it, for the one kind the web2 admin refuses. */
  note: string | null;
}

/** Which token the stage's uploader presents to the web2 admin: its own, a shared one, or none. */
export function tokenView(adminToken: ConsoleStageRecord['adminToken']): TokenView {
  if (adminToken === null) return { label: 'None', tone: 'gray', note: null };
  switch (adminToken.kind) {
    case 'own':
      return { label: 'Own', tone: 'ok', note: null };
    case 'shared':
      return {
        label: 'Shared',
        tone: 'err',
        note: `The web2 admin refuses a token the manager did not generate. ${ROTATE_ADMIN_TOKEN_LABEL} on the deployment page, then redeploy.`,
      };
  }
}

/**
 * How long ago a moment was, in the largest whole unit: seconds for the first minute, as the stage card says it, then
 * minutes, hours and days. A moment ahead of the clock is now, and one that is no moment is the no-value dash.
 */
export function agoText(at: string, now: number): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return NO_VALUE;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * How urgent each push outcome is. A push the admin answered is fine, one it refused or that reached no admin is an
 * error, a stage left unpushed by the operator's own setup is off, and one left unpushed for a gap to fill is a
 * warning.
 */
const PUSH_TONE: Readonly<Record<StagePushOutcome, Tone>> = {
  stored: 'ok',
  'older-ignored': 'info',
  retired: 'gray',
  'not-retired': 'gray',
  'refused-token': 'err',
  'refused-record': 'err',
  unreachable: 'err',
  redirected: 'err',
  'not-admin': 'err',
  'skipped-no-link': 'warn',
  // The link was saved before the plain http rule: nothing reaches the admin until it is given https.
  'refused-plain-http': 'err',
  'skipped-not-linked': 'gray',
  'skipped-other-origin': 'gray',
  'skipped-no-record': 'warn',
};

export interface PushView {
  label: string;
  tone: Tone;
  /** How long ago it ended, or null before any push. */
  ago: string | null;
  /** When it ended, in full, for the hover. */
  at: string | null;
}

/** The last push in the words the stage card uses, with how long ago it ended. */
export function pushView(lastPush: StagePushState | null, now: number): PushView {
  if (!lastPush) return { label: 'Not pushed yet', tone: 'gray', ago: null, at: null };
  const text = STAGE_PUSH_OUTCOME_TEXT[lastPush.outcome];
  return {
    label: text.charAt(0).toUpperCase() + text.slice(1),
    tone: PUSH_TONE[lastPush.outcome],
    ago: agoText(lastPush.at, now),
    at: formatDateTime(lastPush.at),
  };
}

export interface StageRecordView {
  kind: string;
  status: StatusView;
  readiness: ReadinessView;
  owner: OwnerView;
  ingest: IngestView;
  token: TokenView;
}

export interface StageRowView {
  name: string;
  /** The record's columns, or null when the manager could not put the record together. */
  record: StageRecordView | null;
  /** Why the record could not be put together, which the row says in place of its columns. */
  problem: string | null;
  lastPush: PushView;
}

/** One stage as its row shows it. */
export function stageRowView(stage: ConsoleStage, now: number): StageRowView {
  const { record } = stage;
  return {
    name: stage.name,
    record: record && {
      kind: kindLine(record),
      status: statusView(record.status),
      readiness: readinessView(record.readiness),
      owner: ownerView(record.owner),
      ingest: ingestView(record.ingest),
      token: tokenView(record.adminToken),
    },
    problem: stage.problem ?? (record ? null : STAGE_NO_RECORD),
    lastPush: pushView(stage.lastPush, now),
  };
}

/** Every stage's row, by name, so a row stays where it was from one read to the next. */
export function stageRows(stages: readonly ConsoleStage[], now: number): StageRowView[] {
  return [...stages].sort((a, b) => a.name.localeCompare(b.name)).map((stage) => stageRowView(stage, now));
}

/** What the page says when a read fails: why, and how old the answer it still shows is, when it has one. */
export function readFailureLine(error: string, readAt: string | null, now: number): string {
  if (readAt === null) return `Could not read the stages from the manager. ${error}`;
  return `Could not read the stages again, so the table is the answer read ${agoText(readAt, now)}. ${error}`;
}
