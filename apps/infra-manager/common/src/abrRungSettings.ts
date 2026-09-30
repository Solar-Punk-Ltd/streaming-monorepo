/**
 * The picture size and bitrate of each rung of the ABR ladder, as engine
 * settings an operator changes per deployment.
 *
 * The rung names are fixed: the node pool runs one Bee node per rung named
 * after it, and the uploader refuses to start unless the pool covers the
 * ladder exactly. What moves is each rung's width, height and bitrate. The
 * stack reads the whole ladder from one key, `ABR_LADDER`, so these settings
 * are never written as lines of their own. The manager composes that key from
 * them where it writes `BEE_PUBLISHERS`, see `composedAbrLadderEnvValue`.
 */
import { DEFAULT_QUALITY_LADDER, type QualityRung } from '@streaming-monorepo/contracts';

import { abrLadderEnvValue } from './abrLadder.js';
import type { EngineSettingField, EngineSettings } from './engineSettings.js';

/** The one env key the engine and the uploader read the whole ladder from. */
export const ABR_LADDER_ENV_KEY = 'ABR_LADDER';

/** An env key a setting is written into as a part, rather than as a line of its own. */
export type ComposedEnvKey = typeof ABR_LADDER_ENV_KEY;

/** What one rung setting sets. */
export type AbrRungDimension = 'width' | 'height' | 'kbps';

interface DimensionSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  mustBeEven: boolean;
  help: (rung: string) => string;
}

// The bounds are the manager's. 128 by 72 is the floor chosen here, small
// enough for any thumbnail rung and large enough that the encoder still
// encodes it. 3840 by 2160 is 4K, and 20000 kbps is well past what a 4K live
// rung needs. The stack refuses only odd sizes and values that are not
// positive whole numbers.
const DIMENSIONS: Readonly<Record<AbrRungDimension, DimensionSpec>> = {
  width: {
    label: 'width',
    unit: 'pixels',
    min: 128,
    max: 3840,
    mustBeEven: true,
    help: (rung) =>
      `How wide the ${rung} picture is encoded. Keep it in step with the height so the picture is not stretched, 16 by 9 for most sources. It has to be even, because the H.264 encoder refuses odd sizes.`,
  },
  height: {
    label: 'height',
    unit: 'pixels',
    min: 72,
    max: 2160,
    mustBeEven: true,
    help: (rung) =>
      `How tall the ${rung} picture is encoded. It has to be even, and taller than the rung below it, because players tell the rungs apart by their size. The rung keeps its name whatever size you give it.`,
  },
  kbps: {
    label: 'bitrate',
    unit: 'kbps',
    min: 100,
    max: 20_000,
    mustBeEven: false,
    help: (rung) =>
      `The most the ${rung} video may use, in kilobits per second. It has to be higher than the rung below it, or a viewer who steps down to save bandwidth saves none. A higher bitrate also fills this rung's postage batch faster.`,
  },
};

const DIMENSION_ORDER: readonly AbrRungDimension[] = ['width', 'height', 'kbps'];

/** The setting key for one dimension of one rung, such as `ABR_RUNG_1080P_WIDTH`. */
export function abrRungSettingKey(rung: string, dimension: AbrRungDimension): string {
  return `ABR_RUNG_${rung.toUpperCase()}_${dimension.toUpperCase()}`;
}

function rungField(rung: QualityRung, dimension: AbrRungDimension): EngineSettingField {
  const spec = DIMENSIONS[dimension];
  return {
    key: abrRungSettingKey(rung.name, dimension),
    label: `${rung.name} ${spec.label}`,
    unit: spec.unit,
    kind: 'integer',
    defaultValue: String(rung[dimension]),
    min: spec.min,
    max: spec.max,
    ...(spec.mustBeEven ? { mustBeEven: true } : {}),
    help: spec.help(rung.name),
    abrOnly: true,
    composedInto: ABR_LADDER_ENV_KEY,
  };
}

/** Width, height and bitrate of every rung, lowest rung first, grouped by rung. */
export const ABR_RUNG_SETTINGS: readonly EngineSettingField[] = DEFAULT_QUALITY_LADDER.flatMap((rung) =>
  DIMENSION_ORDER.map((dimension) => rungField(rung, dimension)),
);

function rungValue(settings: EngineSettings, rung: QualityRung, dimension: AbrRungDimension): number {
  const stored = settings[abrRungSettingKey(rung.name, dimension)]?.trim();
  return stored ? Number(stored) : rung[dimension];
}

/** The ladder these settings describe, lowest rung first: each stored value, else the shipped one. */
export function abrLadderOf(settings: EngineSettings): QualityRung[] {
  return DEFAULT_QUALITY_LADDER.map((rung) => ({
    name: rung.name,
    width: rungValue(settings, rung, 'width'),
    height: rungValue(settings, rung, 'height'),
    kbps: rungValue(settings, rung, 'kbps'),
  }));
}

/** The `ABR_LADDER` value a deployment with these engine settings gets. */
export function composedAbrLadderEnvValue(settings: EngineSettings): string {
  return abrLadderEnvValue(abrLadderOf(settings));
}

/**
 * The first pair of neighbouring rungs out of order, in words an operator can
 * act on, or null. Each rung has to be taller and cost more than the one below
 * it, or stepping up the ladder buys no sharper picture and stepping down saves
 * no bandwidth. Values that are not whole numbers are left to the field check.
 */
export function abrLadderOrderProblem(settings: EngineSettings): string | null {
  const ladder = abrLadderOf(settings);
  if (ladder.some((rung) => ![rung.width, rung.height, rung.kbps].every(Number.isInteger))) return null;
  for (let index = 1; index < ladder.length; index++) {
    const lower = ladder[index - 1]!;
    const upper = ladder[index]!;
    if (upper.height <= lower.height) {
      return (
        `The ${upper.name} rung has to be taller than the ${lower.name} rung below it. ` +
        `It is ${upper.height} pixels tall and the ${lower.name} rung is ${lower.height}, so a viewer stepping up would get no sharper picture.`
      );
    }
    if (upper.kbps <= lower.kbps) {
      return (
        `The ${upper.name} rung has to have a higher bitrate than the ${lower.name} rung below it. ` +
        `It is ${upper.kbps} kbps and the ${lower.name} rung is ${lower.kbps}, so a viewer stepping down would save no bandwidth.`
      );
    }
  }
  return null;
}
