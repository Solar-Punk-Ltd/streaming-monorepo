import { z } from 'zod';

import { UUID_PATTERN } from './adminApi.js';

/**
 * A stage is a manager deployment that runs a stream uploader, with the node pool behind it. The manager pushes one
 * record per stage into the admin it is linked to, and one record for the brand's catalogue stamp, and the admin
 * keeps the latest of each. `docs/architecture/stages.md` is the design.
 *
 * Every object here is a `z.object`, so a field a newer sender adds is dropped on the way in rather than refused, and
 * nothing the schemas do not name is ever stored. That is also the guard on what the records may carry: no signing
 * key, wallet key, RPC endpoint, token or rung node address has a field, so none survives a parse.
 */

export const STAGE_RECORD_SCHEMA_VERSION = 1 as const;

/** The deployment kinds that run a stream uploader, as the manager names them. */
export const STAGE_KINDS = ['abr-uploader', 'streamer'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** The ingest engines a stage can run. Only SRS stages take streams in this round; an OME stage is listed. */
export const STAGE_ENGINES = ['srs', 'ome'] as const;
export type StageEngine = (typeof STAGE_ENGINES)[number];

/** What a batch is worth right now, in the manager's own words (`StampState` in the manager's common package). */
export const STAGE_STAMP_STATES = ['none', 'unknown', 'active', 'pending', 'full', 'expired', 'gone'] as const;
export type StageStampState = (typeof STAGE_STAMP_STATES)[number];

/** A chequebook against its floor, in the manager's own words (`ChequebookState` in the manager's common package). */
export const STAGE_CHEQUEBOOK_HEALTHS = ['unknown', 'ok', 'low', 'empty'] as const;
export type StageChequebookHealth = (typeof STAGE_CHEQUEBOOK_HEALTHS)[number];

/** The manager's verdict on a stage, worked out in the manager and shown by the admin as it is. */
export const STAGE_READINESS_TONES = ['ready', 'warning', 'blocked', 'unknown'] as const;
export type StageReadinessTone = (typeof STAGE_READINESS_TONES)[number];

/**
 * Where the token a stage's uploader presents came from: `own`, the one the manager generated for the deployment, or
 * `shared`, any other (one copied from the admin link by an older manager, typed, or set by the version). Only an
 * `own` token is taken on the uploader's routes; since phase 9 a `shared` one is refused there, and the stage must
 * have its token rotated in the manager, whose next deploy generates one of its own.
 */
export const ADMIN_TOKEN_KINDS = ['own', 'shared'] as const;
export type AdminTokenKind = (typeof ADMIN_TOKEN_KINDS)[number];

/**
 * How much life left in a batch is worth warning about: two days. The manager warns about a rung's batch by it, and
 * the admin about the catalogue's.
 */
export const STAMP_EXPIRY_WARNING_SECONDS = 48 * 60 * 60;

/** `PUT` and `DELETE` of one stage's record, which the manager calls. */
export function stageRecordPath(stageId: string): string {
  if (!UUID_PATTERN.test(stageId)) throw new Error('A stage id is a UUID.');
  return `/api/internal/stages/${stageId.toLowerCase()}`;
}

/** `PUT` and `DELETE` of the brand's catalogue stamp record, which the manager calls. */
export const CATALOGUE_STAMP_PATH = '/api/internal/catalogue-stamp';

/**
 * `GET`: the stage an uploader's token belongs to, which the uploader calls. `self` is never a UUID, so it cannot be
 * taken for a stage id.
 */
export const STAGE_SELF_PATH = '/api/internal/stages/self';

/**
 * `GET`, on the registrar token alone: answers 204 and does nothing else. The manager's Test connection on its link
 * proves the stored token with it, since the uploader's routes no longer take that token.
 */
export const REGISTRAR_CHECK_PATH = '/api/internal/registrar';

const someText = z.string().min(1);

/** A UUID in either case, kept in lower case, so one id is one row whichever way the sender printed it. */
const uuid = z
  .string()
  .regex(UUID_PATTERN, 'must be a UUID')
  .transform((id) => id.toLowerCase());

/** A moment with its offset, as `Date.prototype.toISOString` writes one. */
const isoMoment = z.iso.datetime({ offset: true });

/** A batch id as Bee prints it: 64 hex digits and no `0x`, kept in lower case. */
const batchId = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex digits without 0x')
  .transform((id) => id.toLowerCase());

/** An address, `0x` and 40 hex digits, kept in lower case. `sameFeedOwner` compares it with one in any other form. */
const ownerAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be 0x and 40 hex digits')
  .transform((address) => address.toLowerCase());

const sha256Hex = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex digits')
  .transform((digest) => digest.toLowerCase());

const port = z.number().int().min(1).max(65535);

/** An amount of BZZ as the manager prints one: digits, and a fraction when there is one. */
const bzzAmount = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal amount');

/**
 * The address encoders dial: a host name, an IPv4 address or an IPv6 one in brackets, with no scheme, port, path or
 * credential, kept in lower case. It goes into an `srt://` or `rtmp://` address as it is, so it is refused unless a
 * URL reads it back unchanged.
 */
const ingestHost = z
  .string()
  .min(1)
  .max(253)
  .refine((host) => {
    try {
      const url = new URL(`http://${host}`);
      return url.host === host.toLowerCase() && url.port === '' && url.pathname === '/' && !url.username;
    } catch {
      return false;
    }
  }, 'must be a host name or an address, with no scheme, port or path')
  .transform((host) => host.toLowerCase());

/** An http or https address with no credential and no fragment, as the admin dials it. */
const beeApiUrl = z.string().refine((text) => {
  try {
    const url = new URL(text);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !text.includes('#')
    );
  } catch {
    return false;
  }
}, 'must be an http or https address with no credential and no fragment');

/** One rung's batch, as the manager read it from the rung's node. */
export const stageStampSchema = z.object({
  batchId,
  state: z.enum(STAGE_STAMP_STATES),
  /** Seconds left, when the node said. Bee reports a negative value when it cannot work it out. */
  ttlSeconds: z.number().nullable(),
  /** How full the fullest bucket is, when the node said enough to tell. */
  fillRatio: z.number().nullable(),
  /** Whether the batch refuses uploads into a full bucket, when the node said. */
  immutable: z.boolean().nullable(),
});
export type StageStamp = z.infer<typeof stageStampSchema>;

/** One rung's chequebook against its floor, and what it can still pay with in BZZ when the node said. */
export const stageChequebookSchema = z.object({
  health: z.enum(STAGE_CHEQUEBOOK_HEALTHS),
  availableBzz: bzzAmount.nullable(),
});
export type StageChequebook = z.infer<typeof stageChequebookSchema>;

/** One rung of a stage: its name, its batch and its chequebook, each null when the manager has no reading. */
export const stageRungSchema = z.object({
  name: someText,
  stamp: stageStampSchema.nullable(),
  chequebook: stageChequebookSchema.nullable(),
});
export type StageRung = z.infer<typeof stageRungSchema>;

/**
 * Where encoders send a stage's streams. An empty passphrase is read as none, since SRT has no empty one.
 */
export const stageIngestSchema = z.object({
  host: ingestHost,
  srtPort: port,
  rtmpPort: port,
  rtmpPublic: z.boolean(),
  srtPassphrase: z.preprocess((value) => (value === '' ? null : value), z.string().nullable()),
});
export type StageIngest = z.infer<typeof stageIngestSchema>;

/**
 * The uploader's health as the manager read it, or null on the record when it could not be read. The state and the
 * reasons are the manager's words, passed through as written, so a state of a newer manager still reaches the page.
 * The node the uploader waits for is not carried.
 */
export const stageUploaderSchema = z.object({
  state: someText,
  reasons: z.array(z.string()),
});
export type StageUploader = z.infer<typeof stageUploaderSchema>;

export const stageReadinessSchema = z.object({
  tone: z.enum(STAGE_READINESS_TONES),
  reasons: z.array(z.string()),
});
export type StageReadiness = z.infer<typeof stageReadinessSchema>;

/** The token a stage's uploader presents to the admin, by its sha256 only. */
export const stageAdminTokenSchema = z.object({
  sha256: sha256Hex,
  kind: z.enum(ADMIN_TOKEN_KINDS),
});
export type StageAdminToken = z.infer<typeof stageAdminTokenSchema>;

/**
 * `PUT /api/internal/stages/:stageId`: one stage as the manager read it at `observedAt`. The owner is the address the
 * stage's feeds are signed as, never the key.
 */
export const stageRecordSchema = z.object({
  schemaVersion: z.literal(STAGE_RECORD_SCHEMA_VERSION),
  stageId: uuid,
  managerId: uuid,
  name: someText,
  kind: z.enum(STAGE_KINDS),
  engine: z.enum(STAGE_ENGINES),
  stackVersion: z.string().nullable(),
  status: someText,
  observedAt: isoMoment,
  ingest: stageIngestSchema,
  owner: ownerAddress,
  rungs: z.array(stageRungSchema),
  uploader: stageUploaderSchema.nullable(),
  readiness: stageReadinessSchema,
  adminToken: stageAdminTokenSchema.nullable(),
});
export type StageRecord = z.infer<typeof stageRecordSchema>;

/**
 * The batch the catalogue is moving from, while a move is pending in the manager, as the manager read it at the
 * record's `observedAt`. The admin keeps writing with that batch until its own move runs, so this is how its readings
 * stay fresh there: a top-up of it reaches the admin, and a time to live that only ages does not refuse writes.
 */
export const catalogueStampPreviousSchema = z.object({
  nodeName: someText,
  beeApiUrl,
  batchId,
  immutable: z.boolean(),
  depth: z.number().int().min(17).max(64),
  state: z.enum(STAGE_STAMP_STATES),
  ttlSeconds: z.number().nullable(),
  fillRatio: z.number().nullable(),
});
export type CatalogueStampPrevious = z.infer<typeof catalogueStampPreviousSchema>;

/**
 * `PUT /api/internal/catalogue-stamp`: the brand's catalogue batch on its dedicated node, as the manager read it at
 * `observedAt`. The Bee API address is the one the admin dials to write the catalogue. `previous` is the batch the
 * catalogue is moving from, null or absent when no move is pending or the manager could not read it; a manager older
 * than the field sends none.
 */
export const catalogueStampRecordSchema = z.object({
  schemaVersion: z.literal(STAGE_RECORD_SCHEMA_VERSION),
  managerId: uuid,
  nodeName: someText,
  beeApiUrl,
  batchId,
  immutable: z.boolean(),
  depth: z.number().int().min(17).max(64),
  state: z.enum(STAGE_STAMP_STATES),
  ttlSeconds: z.number().nullable(),
  fillRatio: z.number().nullable(),
  designatedAt: isoMoment,
  observedAt: isoMoment,
  previous: catalogueStampPreviousSchema.nullish(),
});
export type CatalogueStampRecord = z.infer<typeof catalogueStampRecordSchema>;

/** What `PUT /api/internal/stages/:stageId` answers: false when the admin holds a newer record and kept it. */
export const stageStoreAnswerSchema = z.object({ stored: z.boolean() });
export type StageStoreAnswer = z.infer<typeof stageStoreAnswerSchema>;

/**
 * `DELETE /api/internal/stages/:stageId`: the moment the manager saw the deployment gone. A record observed before it
 * does not bring the stage back, and a stage the admin never stored is kept out until one observed after it arrives.
 */
export const stageRetireRequestSchema = z.object({ observedAt: isoMoment });
export type StageRetireRequest = z.infer<typeof stageRetireRequestSchema>;

/**
 * What `DELETE /api/internal/stages/:stageId` answers: true when this call retired a stored stage. False when there
 * was no such stage (the retirement is still kept), when it was retired already, or when the admin holds a record
 * observed after the moment the call names.
 */
export const stageRetireAnswerSchema = z.object({ retired: z.boolean() });
export type StageRetireAnswer = z.infer<typeof stageRetireAnswerSchema>;

/** `DELETE /api/internal/catalogue-stamp`: the moment the manager saw the designation gone, under the same rule. */
export const catalogueStampClearRequestSchema = z.object({ observedAt: isoMoment });
export type CatalogueStampClearRequest = z.infer<typeof catalogueStampClearRequestSchema>;

/**
 * What `DELETE /api/internal/catalogue-stamp` answers: true when this call cleared a designation the admin held.
 * False when there was none (the clear is still kept), when it was cleared already, or when the admin holds a record
 * observed after the moment the call names.
 */
export const catalogueStampClearAnswerSchema = z.object({ cleared: z.boolean() });
export type CatalogueStampClearAnswer = z.infer<typeof catalogueStampClearAnswerSchema>;

/** What `GET /api/internal/stages/self` answers: the caller's stage and the owner it signs as. */
export const stageSelfAnswerSchema = z.object({ stageId: uuid, owner: ownerAddress });
export type StageSelfAnswer = z.infer<typeof stageSelfAnswerSchema>;

/**
 * An older record never replaces a newer one: whether `incoming` was read before `stored`. Two records read at the
 * same moment are not older than each other, so the manager's repeat of one record stores again. Both moments are
 * ones a schema here has checked.
 */
export function isOlderStageRecord(
  incoming: Pick<StageRecord, 'observedAt'>,
  stored: Pick<StageRecord, 'observedAt'>,
): boolean {
  return Date.parse(incoming.observedAt) < Date.parse(stored.observedAt);
}
