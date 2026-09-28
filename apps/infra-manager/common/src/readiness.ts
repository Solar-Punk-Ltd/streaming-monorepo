import type { StageReadiness, StageReadinessTone } from '@streaming-monorepo/contracts';

import type { ChequebookHealth } from './chequebook.js';
import { type ReadinessProfile, shapeOf } from './deploymentShape.js';
import {
  buildChecklist,
  type ChecklistInput,
  firstBlocker,
  type ReadinessWallet,
  type StepState,
} from './readinessChecklist.js';
import { stampHealthFrom, type StampHealth } from './stampHealth.js';
import type { UploaderHealthReading } from './uploaderHealth.js';

/**
 * A deployment's readiness in one line: the first step of its list that is not
 * ok, or what it is once every step is. The console shows it on every row and
 * page, and the manager hands it to the web2 admin on each stage's record.
 */

/** How urgent a readiness is, in the five levels every pill, dot and banner of the console uses. */
export type ReadinessTone = 'ok' | 'warn' | 'err' | 'info' | 'gray';

export interface Readiness {
  label: string;
  tone: ReadinessTone;
}

export const NEEDS_A_STAMP = 'Needs a stamp';
export const STAMP_EXPIRED = 'Stamp expired';
export const UPLOADER_NOT_STARTED = 'Uploader not started';
export const STAMP_ENDS_SOON = 'Stamp ends soon';
export const POOL_STRING_INVALID = 'Pool string invalid';
export const CHEQUEBOOK_EMPTY = 'Chequebook empty';
export const CHEQUEBOOK_LOW = 'Chequebook low';

const STEP_TONES: Record<StepState, ReadinessTone> = { ok: 'ok', warn: 'warn', err: 'err', busy: 'info', off: 'gray' };

export function readinessFor(input: ChecklistInput): Readiness {
  const blocker = firstBlocker(buildChecklist(input));
  if (blocker) return { label: blocker.problem ?? blocker.title, tone: STEP_TONES[blocker.state] };
  return {
    label: shapeOf(input.profile) === 'bee-node' ? 'Node prerequisites checked' : 'Containers running',
    tone: 'ok',
  };
}

/**
 * Readiness from the readings a view holds, which for most views is no wallet
 * at all, because no list asks a node for its balances.
 *
 * A view that does read one passes it: undefined while the reading has not
 * arrived, null where its node was asked and said nothing, and the balances
 * themselves once they are in. A row showing a zero BZZ balance beside a pill
 * that never looked at it is how this was noticed.
 */
export function readinessOf(
  profile: ReadinessProfile,
  health?: StampHealth,
  chequebook?: ChequebookHealth | null,
  { wallet, uploaderHealth }: OtherReadings = {},
): Readiness {
  return readinessFor(readinessInputOf(profile, health, chequebook, { wallet, uploaderHealth }));
}

/** The checklist input `readinessOf` judges, for a caller that wants the whole list and not only its first blocker. */
export function readinessInputOf(
  profile: ReadinessProfile,
  health?: StampHealth,
  chequebook?: ChequebookHealth | null,
  { wallet, uploaderHealth }: OtherReadings = {},
): ChecklistInput {
  return {
    profile,
    stampHealth: health ?? stampHealthFrom(profile.stamp_id, null),
    chequebook: chequebook ?? null,
    wallet,
    nodeAddress: null,
    currentStamp: null,
    publishUrl: null,
    clientUrl: null,
    streamers: [],
    ...(uploaderHealth ? { uploaderHealth } : {}),
  };
}

/** The readings some views take beside a batch and a chequebook, each absent where the view did not. */
export interface OtherReadings {
  /** Undefined while the view has not read it, null where the node was asked and said nothing. */
  wallet?: ReadinessWallet | null;
  /** What the deployment's uploader said about itself, undefined where nobody asked it. */
  uploaderHealth?: UploaderHealthReading;
}

export function needsAttention(
  profile: ReadinessProfile,
  health?: StampHealth,
  chequebook?: ChequebookHealth | null,
  uploaderHealth?: UploaderHealthReading,
): boolean {
  const { tone } = readinessOf(profile, health, chequebook, { uploaderHealth });
  return tone === 'warn' || tone === 'err';
}

/**
 * How a console tone reads on a stage record.
 *
 * - `ok` is `ready`: every step of the list is ok.
 * - `warn` is `warning`: the stage can take a stream, and something is short, like a batch that ends soon or an
 *   uploader waiting for its node.
 * - `err` is `blocked`: the node or the uploader refuses, like a full batch or an empty chequebook.
 * - `gray` is `blocked` as well: a step that is off is one nothing acts on until an operator does, like a stopped
 *   deployment or a batch still to buy, and a stream sent to it goes nowhere.
 * - `info` is `unknown`: the step is under way or its reading has not arrived, like a deploy or a batch settling, so
 *   the manager has no verdict yet.
 */
export const STAGE_READINESS_OF_TONE: Readonly<Record<ReadinessTone, StageReadinessTone>> = {
  ok: 'ready',
  warn: 'warning',
  err: 'blocked',
  gray: 'blocked',
  info: 'unknown',
};

/**
 * The readiness of a stage as the manager hands it to the web2 admin. The verdict is `readinessFor`'s, the one the
 * console shows, and the reasons are the problem of every step of the list that is not ok, in the list's order, so
 * the first reason is the console's own label. A stage that is ready has none.
 */
export function stageReadinessOf(input: ChecklistInput): StageReadiness {
  const { tone } = readinessFor(input);
  const reasons = buildChecklist(input)
    .filter((step) => step.state !== 'ok')
    .map((step) => step.problem ?? step.title);
  return { tone: STAGE_READINESS_OF_TONE[tone], reasons };
}
