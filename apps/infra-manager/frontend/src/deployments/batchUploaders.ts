import {
  type DeploymentSettingsApplied,
  type DeploymentSettingsCatalog,
  engineOfServices,
  INGEST_READ,
  type IngestHealthReading,
  parseBeePublishers,
  RTMP_INGEST_NO_REPORTS,
  sameBatchId,
  SRT_INGEST_MEASURED,
} from '@streaming-infra-manager/common';

import type { ConfirmRequest } from '../components/ConfirmDialog';
import { shortHex } from '../format';
import type { Profile } from '../types';
import { wordList } from './settings/settingsText';

/**
 * The stream uploaders that pay with a Bee node's batches, and what the
 * node's Storage card says about them after a Use (SPDV-1437).
 *
 * A stream uploader reads its batch once, when it starts, from `STAMP` on a
 * single-node deployment and from its rung's entry in `BEE_PUBLISHERS` on an
 * ABR stage. Use stores the batch and restarts nothing, so the card compares
 * what each uploader's next deploy pays with against what its running
 * container was started with, both read from that deployment's settings list,
 * and offers the settings list's own Apply for each one that is behind.
 */

const STAMP_KEY = 'STAMP';
const BEE_PUBLISHERS_KEY = 'BEE_PUBLISHERS';

/** One stream uploader that pays with this node's batches. */
export interface BatchUploader {
  /** The deployment that runs it. */
  name: string;
  /** What its Apply names, so a deployment recreated under the name refuses it. */
  instanceId: string;
  /** The page's own deployment, rather than a stage its rung publishes for. */
  own: boolean;
  /** The batch its next deploy pays with for this node. */
  savedBatchId: string | null;
  /** The batch its running container was started with for this node, or null when nothing records it. */
  runningBatchId: string | null;
  /** Its containers run and were started with another batch for this node than the saved one. */
  behind: boolean;
  /** What its Apply recreates, every service when a changed key reaches the deploy scripts alone. */
  recreates: readonly string[] | 'all';
  /** The key that carries this node's batch to the uploader, `STAMP` or `BEE_PUBLISHERS`. */
  batchKey: string;
  /** Every saved key the running containers are behind on, which Apply applies all together. */
  changedKeys: readonly string[];
}

/** How a batch the node holds stands against the uploaders that pay with the node's batches. */
export type BatchUse = 'in-use' | 'saved-waiting' | 'running-not-saved';

function sameBatch(a: string, b: string): boolean {
  return sameBatchId(a.toLowerCase(), b.toLowerCase());
}

function recreatesOf(catalog: DeploymentSettingsCatalog): BatchUploader['recreates'] {
  return catalog.drift.fullRedeploy ? 'all' : catalog.drift.services;
}

/** A single-node deployment's own uploader, from its settings list, or null when the list has no `STAMP`. */
export function ownUploaderOf(name: string, catalog: DeploymentSettingsCatalog): BatchUploader | null {
  const entry = catalog.entries.find((candidate) => candidate.key === STAMP_KEY);
  if (!entry) return null;
  return {
    name,
    instanceId: catalog.instanceId,
    own: true,
    savedBatchId: entry.value || null,
    runningBatchId: entry.runningValue,
    behind: catalog.running && entry.running === 'differs',
    recreates: recreatesOf(catalog),
    batchKey: STAMP_KEY,
    changedKeys: catalog.drift.keys,
  };
}

function rungBatchOf(poolString: string | null, rung: string): string | null {
  if (!poolString) return null;
  return parseBeePublishers(poolString)?.find((entry) => entry.rung === rung)?.batchId ?? null;
}

/**
 * A stage's uploader as it pays for one rung, from the stage's settings list.
 * Behind only on this rung: a pool string that moved for another rung is that
 * rung's page to report. Where nothing records what the uploader runs, a
 * string that differs at all counts as behind.
 */
export function stageUploaderOf(name: string, catalog: DeploymentSettingsCatalog, rung: string): BatchUploader | null {
  const entry = catalog.entries.find((candidate) => candidate.key === BEE_PUBLISHERS_KEY);
  if (!entry) return null;
  const savedBatchId = rungBatchOf(entry.value, rung);
  const runningBatchId = rungBatchOf(entry.runningValue, rung);
  const rungDiffers = savedBatchId === null || runningBatchId === null || !sameBatch(savedBatchId, runningBatchId);
  return {
    name,
    instanceId: catalog.instanceId,
    own: false,
    savedBatchId,
    runningBatchId,
    behind: catalog.running && entry.running === 'differs' && rungDiffers,
    recreates: recreatesOf(catalog),
    batchKey: BEE_PUBLISHERS_KEY,
    changedKeys: catalog.drift.keys,
  };
}

/**
 * The stages a rung node publishes for: those whose stored pool string names,
 * for this rung, a batch the node holds. A batch belongs to one node, so the
 * batch identifies the node without the address the manager writes for it.
 */
export function stagesUsingNode(
  profiles: readonly Pick<Profile, 'name' | 'bee_publishers'>[],
  rung: string,
  nodeBatchIds: readonly string[],
): string[] {
  return profiles
    .filter((profile) => {
      const batch = rungBatchOf(profile.bee_publishers ?? null, rung);
      return batch !== null && nodeBatchIds.some((held) => sameBatch(held, batch));
    })
    .map((profile) => profile.name);
}

/**
 * Where nothing records what any uploader runs (a stopped deployment, one
 * deployed before the manager kept records, a rung no stage publishes for),
 * the saved batch is what the next start pays with, so it reads as in use.
 */
export function batchUseOf(
  batchId: string,
  savedBatchId: string | null | undefined,
  uploaders: readonly BatchUploader[],
): BatchUse | null {
  const saved = savedBatchId != null && sameBatch(savedBatchId, batchId);
  const runningIds = uploaders.flatMap((uploader) => (uploader.runningBatchId ? [uploader.runningBatchId] : []));
  if (runningIds.length === 0) return saved ? 'in-use' : null;
  const running = runningIds.some((id) => sameBatch(id, batchId));
  if (saved && running) return 'in-use';
  if (saved) return 'saved-waiting';
  return running ? 'running-not-saved' : null;
}

export interface BatchChip {
  label: string;
  color: 'default' | 'error' | 'warning' | 'info';
}

export function batchChipOf(use: BatchUse, expired: boolean): BatchChip {
  switch (use) {
    case 'in-use':
      return expired ? { label: 'in use, expired', color: 'error' } : { label: 'in use', color: 'default' };
    case 'saved-waiting':
      return { label: 'saved, not in use until Apply', color: 'info' };
    case 'running-not-saved':
      return { label: 'in use until Apply', color: 'warning' };
  }
}

export interface BatchNoticeRow {
  name: string;
  own: boolean;
  /** What its Apply now restarts, as a sentence. */
  what: string;
}

export interface BatchNotice {
  lead: string;
  rows: BatchNoticeRow[];
}

/** The saved keys Apply would carry besides the batch, which the operator did not just choose. */
function otherKeysOf(uploader: BatchUploader): readonly string[] {
  return uploader.changedKeys.filter((key) => key !== uploader.batchKey);
}

function applyWhat(uploader: BatchUploader): string {
  const keys = uploader.changedKeys.length > 0 ? uploader.changedKeys : [uploader.batchKey];
  const restarts =
    uploader.recreates === 'all'
      ? `redeploys every service of ${uploader.name}`
      : `recreates ${wordList(uploader.recreates)}`;
  const others = otherKeysOf(uploader);
  const earlier =
    others.length === 0
      ? ''
      : ` ${wordList(others)} ${others.length === 1 ? 'was' : 'were'} saved earlier and not applied yet.`;
  return `Apply now applies ${wordList(keys)} and ${restarts}.${earlier}`;
}

/** What the stamp card says while an uploader still pays with another batch than the saved one, or null. */
export function batchNotice(
  savedBatchId: string | null | undefined,
  uploaders: readonly BatchUploader[],
): BatchNotice | null {
  const behind = uploaders.filter((uploader) => uploader.behind);
  if (behind.length === 0) return null;
  const saved = savedBatchId ? `Batch ${shortHex(savedBatchId)}` : 'The batch';
  const rows = behind.map((uploader) => ({ name: uploader.name, own: uploader.own, what: applyWhat(uploader) }));
  const own = behind.find((uploader) => uploader.own);
  if (own) {
    const paying = own.runningBatchId ? `batch ${shortHex(own.runningBatchId)}` : 'the batch it started with';
    return { lead: `${saved} is saved, but the running uploader still pays with ${paying} until it restarts.`, rows };
  }
  return {
    lead: `${saved} is saved for the stages this rung publishes for. Each stage's uploader still pays with the batch it started with until it restarts.`,
    rows,
  };
}

export type BroadcastState = 'live' | 'idle' | 'unknown';

/**
 * Whether a broadcast is coming in, by the ingest reading the Ingest card
 * shows: SRS reported a publisher over SRT or RTMP in its window. Only SRS
 * reports one, so another engine, a log that could not be read and a manager
 * that did not answer cannot tell.
 */
export function broadcastStateOf(reading: IngestHealthReading | null): BroadcastState {
  if (!reading || reading.state !== INGEST_READ) return 'unknown';
  const publishing = reading.srt.state === SRT_INGEST_MEASURED || reading.rtmp.state !== RTMP_INGEST_NO_REPORTS;
  return publishing ? 'live' : 'idle';
}

/** What Apply now asks before it runs, which the card hands to the console's confirm dialog. */
export interface ApplyConfirm extends Omit<ConfirmRequest, 'body' | 'onConfirm'> {
  body: string;
  onConfirm: () => Promise<void>;
}

/**
 * Whether Apply recreates the media server, or every service, which
 * disconnects the encoder rather than restarting the uploader alone.
 */
function dropsEncoder(uploader: BatchUploader): boolean {
  return uploader.recreates === 'all' || engineOfServices(uploader.recreates) !== null;
}

function restartSentence(uploader: BatchUploader): string {
  if (uploader.recreates === 'all') {
    return `This redeploys every service of ${uploader.name}, so the encoder is disconnected and has to reconnect.`;
  }
  if (dropsEncoder(uploader)) {
    return `This recreates ${wordList(uploader.recreates)}, so the encoder is disconnected and has to reconnect.`;
  }
  const others = uploader.recreates.filter((service) => service !== 'stream-uploader');
  return others.length === 0
    ? 'The stream uploader restarts on the saved batch.'
    : `This recreates ${wordList(uploader.recreates)}.`;
}

function broadcastSentence(uploader: BatchUploader, broadcast: BroadcastState): string | null {
  const effect = dropsEncoder(uploader)
    ? 'stops until the encoder reconnects'
    : 'drops for a few seconds while the uploader restarts';
  if (broadcast === 'live') return `The live broadcast on ${uploader.name} ${effect}.`;
  if (broadcast === 'unknown') {
    const ifLive = dropsEncoder(uploader)
      ? 'it stops until the encoder reconnects'
      : 'it drops for a few seconds while the uploader restarts';
    return `The console cannot tell whether a broadcast is live on ${uploader.name}. If one is, ${ifLive}.`;
  }
  return null;
}

/**
 * What Apply now asks first, or null when it would apply the batch alone and
 * nobody is publishing. Apply carries every saved key the deployment is behind
 * on, so one the operator did not just choose is always asked about.
 */
export function applyConfirmFor(
  uploader: BatchUploader,
  broadcast: BroadcastState,
  onConfirm: () => Promise<void> = async () => undefined,
): ApplyConfirm | null {
  const others = otherKeysOf(uploader);
  if (broadcast === 'idle' && others.length === 0) return null;
  const body = [
    restartSentence(uploader),
    broadcastSentence(uploader, broadcast),
    others.length > 0
      ? `It also applies ${wordList(others)}, saved earlier and not applied yet, not only the batch.`
      : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(' ');
  const title =
    others.length > 0 ? `Apply every saved setting on ${uploader.name}?` : `Apply the saved batch on ${uploader.name}?`;
  return { title, body, confirmLabel: 'Apply now', onConfirm };
}

export interface ApplyNowDeps {
  readIngest: (name: string) => Promise<IngestHealthReading>;
  confirm: (request: ApplyConfirm) => void;
  apply: (name: string, instanceId: string) => Promise<DeploymentSettingsApplied>;
  /** Told once the apply has landed. */
  done: (applied: DeploymentSettingsApplied) => Promise<void> | void;
}

/**
 * The settings list's own Apply for one uploader, asked first while its
 * broadcast is live or cannot be told, or while it would apply more than the
 * batch. A failed apply rejects from here, or
 * from the confirmation's onConfirm, for the caller to show.
 */
export async function applyNow(uploader: BatchUploader, deps: ApplyNowDeps): Promise<void> {
  const reading = await deps.readIngest(uploader.name).catch(() => null);
  const run = async () => {
    await deps.done(await deps.apply(uploader.name, uploader.instanceId));
  };
  const request = applyConfirmFor(uploader, broadcastStateOf(reading), run);
  if (request) {
    deps.confirm(request);
    return;
  }
  await run();
}

export interface SetBatchDeps {
  setStamp: (batchId: string) => Promise<unknown>;
  reloadDeployments: () => void;
  rereadUploaders: () => Promise<void>;
}

/** Use: store the batch, then read the deployments and every uploader's settings again at once. */
export async function setBatchAndReread(batchId: string, deps: SetBatchDeps): Promise<void> {
  await deps.setStamp(batchId);
  deps.reloadDeployments();
  await deps.rereadUploaders();
}
