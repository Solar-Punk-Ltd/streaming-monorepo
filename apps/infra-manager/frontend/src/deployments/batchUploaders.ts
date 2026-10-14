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
 * the saved batch is what the next start pays with, so it reads as in use,
 * unless an uploader is known to be behind on it.
 */
export function batchUseOf(
  batchId: string,
  savedBatchId: string | null | undefined,
  uploaders: readonly BatchUploader[],
): BatchUse | null {
  const saved = savedBatchId != null && sameBatch(savedBatchId, batchId);
  const runningIds = uploaders.flatMap((uploader) => (uploader.runningBatchId ? [uploader.runningBatchId] : []));
  const running = runningIds.some((id) => sameBatch(id, batchId));
  const waitedOn = uploaders.some(
    (uploader) => uploader.behind && uploader.savedBatchId !== null && sameBatch(uploader.savedBatchId, batchId),
  );
  if (saved && running) return 'in-use';
  if (saved && (waitedOn || runningIds.length > 0)) return 'saved-waiting';
  if (saved) return 'in-use';
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

/**
 * `quiet` is SRS reporting no publisher in its window. It is never taken as
 * nobody publishing, because SRS reports a publisher only about every ten
 * seconds, so one that connected moments ago has no report yet.
 */
export type BroadcastState = 'live' | 'quiet' | 'unknown';

/**
 * Whether a broadcast is coming in, by the ingest reading the Ingest card
 * shows: SRS reported a publisher over SRT or RTMP in its window. Only SRS
 * reports one, so another engine, a log that could not be read and a manager
 * that did not answer cannot tell.
 */
export function broadcastStateOf(reading: IngestHealthReading | null): BroadcastState {
  if (!reading || reading.state !== INGEST_READ) return 'unknown';
  const publishing = reading.srt.state === SRT_INGEST_MEASURED || reading.rtmp.state !== RTMP_INGEST_NO_REPORTS;
  return publishing ? 'live' : 'quiet';
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

function broadcastSentence(uploader: BatchUploader, broadcast: BroadcastState): string {
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
  const ifLive = dropsEncoder(uploader)
    ? 'it stops until the encoder reconnects'
    : 'it drops for a few seconds while the uploader restarts';
  return `SRS reported no publisher on ${uploader.name} in its last window, but it reports one only about every ten seconds, so a publisher that connected moments ago would not show yet. If one is live, ${ifLive}.`;
}

/**
 * What Apply now asks before it runs. It always asks, because the console is
 * never sure nobody is publishing, and it names any saved key besides the
 * batch, which Apply carries too and the operator did not just choose.
 */
export function applyConfirmFor(
  uploader: BatchUploader,
  broadcast: BroadcastState,
  onConfirm: () => Promise<void> = async () => undefined,
): ApplyConfirm {
  const others = otherKeysOf(uploader);
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

/** How long Apply now waits for the ingest reading before it asks as when it cannot tell. */
const INGEST_READ_DEADLINE_MS = 10_000;

/** How long the card waits for one stage's settings list before it shows the stages that answered. */
const STAGE_READ_DEADLINE_MS = 15_000;

/** Runs a read with a signal that aborts at the deadline, and rejects then whether or not the read heeds it. */
export async function withDeadline<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`No answer within ${ms} ms.`));
    }, ms);
  });
  try {
    return await Promise.race([read(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ApplyNowDeps {
  readIngest: (name: string, signal: AbortSignal) => Promise<IngestHealthReading>;
  /** Defaults to ten seconds. */
  readDeadlineMs?: number;
  confirm: (request: ApplyConfirm) => void;
  apply: (name: string, instanceId: string) => Promise<DeploymentSettingsApplied>;
  /** Told once the apply has landed. */
  done: (applied: DeploymentSettingsApplied) => Promise<void> | void;
}

/**
 * The settings list's own Apply for one uploader, always asked first, in words
 * from the ingest reading. A reading that fails or does not come in time is
 * one that cannot tell. A failed apply rejects from the confirmation's
 * onConfirm, for the caller to show.
 */
export async function applyNow(uploader: BatchUploader, deps: ApplyNowDeps): Promise<void> {
  const reading = await withDeadline(deps.readDeadlineMs ?? INGEST_READ_DEADLINE_MS, (signal) =>
    deps.readIngest(uploader.name, signal),
  ).catch(() => null);
  const run = async () => {
    await deps.done(await deps.apply(uploader.name, uploader.instanceId));
  };
  deps.confirm(applyConfirmFor(uploader, broadcastStateOf(reading), run));
}

/**
 * Every stage's settings list, each read under its own deadline, so a stage
 * that does not answer leaves out itself alone and the rest still show.
 */
export async function readStageCatalogs(
  names: readonly string[],
  read: (name: string, signal: AbortSignal) => Promise<DeploymentSettingsCatalog>,
  deadlineMs: number = STAGE_READ_DEADLINE_MS,
): Promise<{ name: string; catalog: DeploymentSettingsCatalog }[]> {
  const answers = await Promise.allSettled(
    names.map((name) => withDeadline(deadlineMs, (signal) => read(name, signal))),
  );
  return answers.flatMap((answer, index) =>
    answer.status === 'fulfilled' ? [{ name: names[index]!, catalog: answer.value }] : [],
  );
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
