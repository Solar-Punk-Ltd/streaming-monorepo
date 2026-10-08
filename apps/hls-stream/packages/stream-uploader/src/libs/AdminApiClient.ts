import {
  ADMIN_API_TOKEN_MIN_LENGTH,
  ADMIN_ERROR_STREAM_NOT_FOUND,
  feedOwnerOf,
  ingestLookupAnswerSchema,
  ingestLookupPath,
  renditionReportAnswerSchema,
  STAGE_SELF_PATH,
  stageSelfAnswerSchema,
} from '@swarm-hls-stream/shared';

import { MediaType, Rendition } from '../types.js';
import { getErrorMessage } from '../utils/common.js';

import { AdminStreamGoneError } from './AdminStreamGoneError.js';
import { Logger } from './Logger.js';

/**
 * The admin service this uploader answers to when `ADMIN_API_URL` is set. See the "Admin mode"
 * section of the package README.
 *
 * ## What admin mode moves, and why it is a client rather than a catalog
 *
 * Without it, a broadcast is announced by whoever can reach the ingest port with the right key, the
 * uploader mints the feed topic, and the stream catalog on Swarm is the only record that the
 * broadcast exists. Admin mode inverts all three: a stream is *declared first* in the admin service,
 * which mints the topic and the publish key, and the uploader's job is to recognise the ingest
 * session as one of those declarations and to report where it got to. The catalog is then the
 * admin's to write, not this service's — see {@link StreamUploader} for what that suppresses.
 *
 * ## Why the two calls have such different failure policies
 *
 * `lookupByIngestId` runs inside a publish gate, with an engine waiting on the answer and a
 * broadcaster waiting on the engine. There is nothing to retry *into*: a publish that cannot be
 * resolved has to be refused, and refusing takes one round trip rather than three. It therefore
 * throws on everything except a clean 404, and the gate turns a throw into a refusal.
 *
 * `reportState` runs behind a broadcast that is already live. Nobody is waiting, the thing being
 * reported has already happened, and a lost report is a stream that plays perfectly and is
 * mislabelled in the admin's own list. So it retries, and it never throws: the caller reads the
 * outcome and decides, because the two callers want different things from a failure — see
 * {@link StateReportOutcome}.
 *
 * `fetchStageSelf` and `fetchFeedOwner` run once at boot and never throw either: they confirm that
 * the owner the admin knows for this stage, or for a caller it cannot tie to a stage the address it
 * signs its catalog with, is the one this service signs its feeds with. An admin that cannot be
 * asked yet is a warning rather than a refusal, because the publish gate compares each declaration's
 * owner. See `libs/AdminOwnerCheck.ts`.
 *
 * `reportRendition` follows `reportState`'s policy exactly, on the same ladder and the same timeout,
 * and for the same reason: a rung announcing itself is behind a broadcast that is already running.
 * What it is NOT is optional — the admin holds the ladder's merge state in admin mode, so a report
 * that never lands is a rung missing from the master every viewer resolves. The caller treats a
 * failure as a failed catalog announce and re-attempts on the announce cadence. See
 * `libs/AdminLadderRegistry.ts`.
 */

/** Minimum length for `ADMIN_API_TOKEN`, matching `API_AUTH_TOKEN`'s and the SRS webhook token's. */
export const MIN_ADMIN_API_TOKEN_LENGTH = ADMIN_API_TOKEN_MIN_LENGTH;

/**
 * How long one lookup may take before the gate gives up on it.
 *
 * Bounded by what the engine is holding open, not by what the network might need. SRS waits on the
 * `on_publish` webhook before it admits a publisher and OME's admission timeout is 3000ms, so a
 * lookup that spends much longer than this turns "the admin is slow" into "the engine gave up on the
 * uploader", which is a worse failure than a refusal because it is invisible from this side.
 */
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * How long one state report may take. Twice the lookup's, because nobody is waiting on it and the
 * report the admin has to act on — the VOD flip — is the one it does the most work for.
 */
const DEFAULT_REPORT_TIMEOUT_MS = 10_000;

/**
 * How many times a state report is attempted, and how long it waits in between.
 *
 * Tripling rather than doubling, so three attempts span four seconds rather than three, which is
 * long enough to cross an admin restart and short enough that a finalize is not held for the length
 * of a broadcast. The ladder has one fewer entry than the attempt count by construction: the wait is
 * what happens *between* two attempts, so a fourth attempt would wait 9s.
 */
export const MAX_STATE_REPORT_ATTEMPTS = 3;
export const STATE_REPORT_BACKOFF_MS = [1_000, 3_000] as const;

/** The states a report may claim. `live` on the first published manifest, `vod` once the recording is in the feed. */
export const ADMIN_STATE_LIVE = 'live' as const;
export const ADMIN_STATE_VOD = 'vod' as const;

export type AdminStateReport =
  | { state: typeof ADMIN_STATE_LIVE }
  | {
      state: typeof ADMIN_STATE_VOD;
      /** Feed index of the final manifest, which is what a viewer is pointed at. */
      index: number;
      /** Playing time of the recording in seconds. */
      duration: number;
    };

/**
 * A stream the admin has already declared, resolved from the ingest id an engine reported.
 *
 * The fields this service acts on are `topic`, `publishKey`, `mediaType` and `id`. `owner`, `title`
 * and `status` are carried because they are in the contract and reading them back is how an operator
 * tells a resolved draft from a stale one in a log line; nothing here decides anything on them.
 */
export interface AdminStreamDraft {
  id: string;
  topic: string;
  owner: string;
  mediaType: MediaType;
  title: string;
  status: string;
  publishKey: string;
}

/**
 * What became of a state report.
 *
 * The admin accepts a repeated report from the state it names, so a report this uploader already
 * delivered, a finalize resumed after a crash say, is accepted again. It answers 409 only when the
 * stream cannot take the state now, and its body says which state it holds: see `attemptReport`.
 */
export const STATE_REPORT_ACCEPTED = 'accepted' as const;
export const STATE_REPORT_FAILED = 'failed' as const;
/**
 * The admin answered that it has no such stream, the one failure no later attempt can turn around.
 * Kept apart from {@link STATE_REPORT_FAILED} so a finalize can let go of a broadcast the admin
 * deleted. See {@link AdminStreamGoneError}.
 */
export const STATE_REPORT_STREAM_GONE = 'stream-gone' as const;

export type StateReportOutcome =
  | typeof STATE_REPORT_ACCEPTED
  | typeof STATE_REPORT_FAILED
  | typeof STATE_REPORT_STREAM_GONE;

/** The admin's state for a stream that was never published, or was unpublished, which refuses every report. */
const ADMIN_STATUS_DRAFT = 'draft';

/** Whether the admin now holds the state that was reported, however it got there. */
export function stateWasReported(outcome: StateReportOutcome): boolean {
  return outcome === STATE_REPORT_ACCEPTED;
}

/**
 * The ladder as the admin holds it after merging one rung's record into it.
 *
 * Only the fields this service acts on are declared. The route also answers the whole stream row and
 * the catalog feed write the report caused — both in the contract — and of those only the row's
 * `status` is read, so the rest is deliberately left unnamed rather than carried as fields nothing
 * reads.
 */
export interface RenditionReportResponse {
  /** Every rung the admin holds for this stream after the merge, ascending by height. */
  renditions: Rendition[];
  /**
   * The stream's status as the admin holds it after this report, or null when the body did not say.
   *
   * Read for one decision: whether a ladder that is `finished` has been reported `vod` yet. The admin
   * flips `flippedToFinished` once, on the report that completed the merge, and if the master write
   * behind that report failed the flip is gone for good; the status is what lets the next announce
   * see that the ladder is finished and the admin still says `live`, and report `vod` after all.
   */
  streamStatus: string | null;
  /**
   * The index of the catalog feed write this report caused, or null when the body did not carry one.
   *
   * The admin serialises every catalog write on one mutex and answers each report from inside it, so
   * this number orders answers the way the admin merged them. Four rungs report concurrently and
   * their answers can arrive here in another order; `AdminLadderRegistry` compares this before letting an
   * answer replace the ladder it holds, so an older merge arriving late cannot write a master missing
   * a rung a newer answer already named.
   */
  feedIndex: number | null;
  ladder: {
    /** Every rendition on record carries an index, and there is at least one. */
    finished: boolean;
    /** Finished now, and not finished before this report. At most one report per broadcast sees it. */
    flippedToFinished: boolean;
    /** The recording's playing time in seconds when finished, and null while it is not. */
    duration: number | null;
  };
}

/**
 * What the admin says about the stage this service's token belongs to.
 *
 * - `stage`: it named the stage and the owner that stage signs as.
 * - `no-stage`: it answered 404: an admin from before stages, which has no such route, or the
 *   intermediate admin answering the shared token. The two answer alike, and both are compared with
 *   the public config.
 * - `unconfirmed`: it could not be read: no answer, another status, or a body that is not the answer.
 *   `reason` says which, for the log.
 */
export type StageSelfOutcome =
  | { kind: 'stage'; stageId: string; owner: string }
  | { kind: 'no-stage' }
  | { kind: 'unconfirmed'; reason: string };

interface AdminApiClientOptions {
  baseUrl: string;
  token: string;
  lookupTimeoutMs?: number;
  reportTimeoutMs?: number;
  /** Injected so a test can drive the retry ladder without spending its wall clock on the waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected the way the OME puller's is, so a network path can be driven without a socket. */
  fetcher?: typeof globalThis.fetch;
}

/**
 * "This attempt failed and the next one may not", kept apart from the `null` a settled failure
 * answers with, which for a rendition report is a value the caller acts on rather than a sentinel.
 */
const RENDITION_REPORT_RETRY = Symbol('rendition-report-retry');

/** The admin's own answer that the stream a report named does not exist. See {@link AdminStreamGoneError}. */
const RENDITION_REPORT_STREAM_GONE = Symbol('rendition-report-stream-gone');

/**
 * Whether a refusal is the admin saying it has no such stream, rather than a 404 from a path nobody
 * routes. Read off the body's error code, because a wrong base url or a proxy in front of the admin
 * answers 404 too, and taking that for a deleted stream would let every recovery entry go at once.
 */
function isStreamNotFound(status: number, body: unknown): boolean {
  return (
    status === 404 &&
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>).error === ADMIN_ERROR_STREAM_NOT_FOUND
  );
}

/** Statuses that mean "ask again": the admin is there and could not answer this time. */
function isRetryableReportStatus(status: number): boolean {
  return status >= 500;
}

export function assertUsableAdminApiToken(token: string): void {
  if (token.length < MIN_ADMIN_API_TOKEN_LENGTH) {
    throw new Error(`ADMIN_API_TOKEN must be at least ${MIN_ADMIN_API_TOKEN_LENGTH} characters`);
  }
}

/** The state the admin says a stream holds, off the body of its 409 to a state report, or null. */
function heldStateOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const from = (body as Record<string, unknown>).from;
  return typeof from === 'string' && from.length > 0 ? from : null;
}

export class AdminApiClient {
  private readonly logger = Logger.getInstance();
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly lookupTimeoutMs: number;
  private readonly reportTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: AdminApiClientOptions) {
    assertUsableAdminApiToken(options.token);
    // Trailing slash removed once here rather than guarded at each call site: `${base}/api/...` with
    // a configured `http://admin:9877/` would otherwise produce a double slash, which an admin behind
    // a router answers 404 to, and a 404 on a lookup means "no such stream" rather than "bad url".
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.reportTimeoutMs = options.reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  /** Where this client is pointed, for the one boot line that says which mode the service is in. */
  public describe(): string {
    return this.baseUrl;
  }

  /**
   * The stage the admin ties this service's token to, and the owner it knows for that stage.
   *
   * Boot asks this first. Each stage signs its feeds with a key of its own, and the admin writes that
   * stage's owner into every catalog entry of its streams, so the owner it names here is the one this
   * service has to sign as. The token goes with it, because the answer is about the caller. Never
   * throws, for the reason `fetchFeedOwner` gives.
   */
  public async fetchStageSelf(): Promise<StageSelfOutcome> {
    const url = `${this.baseUrl}${STAGE_SELF_PATH}`;
    try {
      const response = await this.send(url, { method: 'GET' }, this.lookupTimeoutMs);
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'no-stage' };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'unconfirmed', reason: `${url} answered ${response.status}` };
      }
      const answer = stageSelfAnswerSchema.safeParse(await this.readJson(response));
      if (!answer.success) {
        return { kind: 'unconfirmed', reason: `${url} answered 200 with a body that names no stage and owner` };
      }
      return { kind: 'stage', stageId: answer.data.stageId, owner: answer.data.owner };
    } catch (error) {
      return { kind: 'unconfirmed', reason: `${url} did not answer: ${getErrorMessage(error)}` };
    }
  }

  /**
   * The address the admin signs its catalog feed with, read off its public config, or null when it
   * could not be read.
   *
   * Boot asks this when `fetchStageSelf` names no stage: an admin from before stages, or the
   * intermediate admin answering the shared token, where both services still sign as one
   * owner. The admin's catalog entry points a viewer at `owner/topic`, and the master this service
   * writes at that topic resolves only under the key it was signed with. Nothing on the wire carries a
   * key, so the address is the one thing that can be compared, and a deployment where the two differ
   * answers 200 to every report while every viewer resolves a feed nobody wrote. `resolveAdminPublish`
   * runs the per-declaration half of the same check on every publish.
   *
   * Never throws, and null is deliberately not a refusal: an admin that is down while this service
   * boots is a deploy ordering rather than a misconfiguration, and the publish gate compares each
   * declaration's owner anyway.
   */
  public async fetchFeedOwner(): Promise<string | null> {
    const url = `${this.baseUrl}/api/config`;
    try {
      const response = await this.sendPublic(url, { method: 'GET' }, this.lookupTimeoutMs);
      if (!response.ok) {
        this.logger.warn(`[Admin] ${url} answered ${response.status}, so the feed owner could not be confirmed`);
        return null;
      }
      const owner = feedOwnerOf(await this.readJson(response));
      if (owner === null) {
        this.logger.warn(`[Admin] ${url} answered without a feed owner, so it could not be confirmed`);
        return null;
      }
      return owner;
    } catch (error) {
      this.logger.warn(
        `[Admin] ${url} did not answer, so the feed owner could not be confirmed: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * The stream the admin declared for this ingest id, or null when it has declared none.
   *
   * ⛔ Null means exactly one thing: the admin answered 404, so nobody announced this ingest id. Every
   * other outcome throws, including a 200 whose body is not a draft, because the caller turns null
   * into "refuse this publish and say why" and a failed lookup must never be spelled that way. The
   * two are indistinguishable to the broadcaster and completely different to whoever is on call.
   *
   * @param streamId the engine's own `app/stream`, which is the key the admin filed the draft under.
   */
  public async lookupByIngestId(streamId: string): Promise<AdminStreamDraft | null> {
    // Encoded per segment even though `isUsableStreamId` has already restricted these to
    // `[A-Za-z0-9._-]`, where encoding is a no-op. The screening lives in the engines and this is a
    // url; a caller added later that skips it must not be able to write a path of its own.
    const url = `${this.baseUrl}${ingestLookupPath(streamId)}`;

    const response = await this.send(url, { method: 'GET' }, this.lookupTimeoutMs);

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Admin API answered ${response.status} for ${url}`);
    }

    // Screened rather than cast, because the fields decide who may publish and where the broadcast
    // is written: a body missing `publishKey` would be compared against a presented key as undefined,
    // and a missing `topic` would mint a feed at `Topic.fromString(undefined)`.
    const draft = ingestLookupAnswerSchema.safeParse(await this.readJson(response));
    if (!draft.success) {
      throw new Error(`Admin API answered 200 for ${url} with a body that is not a stream`);
    }
    return draft.data;
  }

  /**
   * Tell the admin where a broadcast got to.
   *
   * Never throws: a report is about something that has already happened, and the callers are a live
   * manifest publish and a finalize, neither of which is improved by an exception travelling up
   * through it. The verdict comes back as a value instead, and the caller decides what a failure
   * costs — the live report is retried on the catalog announce's own cadence, the VOD report leaves
   * the recovery entry on disk for the next boot.
   */
  public async reportState(id: string, report: AdminStateReport): Promise<StateReportOutcome> {
    const url = `${this.baseUrl}/api/internal/streams/${encodeURIComponent(id)}/state`;
    const body = JSON.stringify(report);

    for (let attempt = 1; attempt <= MAX_STATE_REPORT_ATTEMPTS; attempt++) {
      const outcome = await this.attemptReport(url, body, report, attempt);
      if (outcome !== null) {
        return outcome;
      }
      const wait = STATE_REPORT_BACKOFF_MS[attempt - 1];
      if (wait !== undefined) {
        await this.sleep(wait);
      }
    }

    this.logger.error(
      `[Admin] Gave up reporting ${report.state} for stream ${id} after ${MAX_STATE_REPORT_ATTEMPTS} attempts. ` +
        'The broadcast itself is unaffected; the admin now holds a state older than the feed.',
    );
    return STATE_REPORT_FAILED;
  }

  /**
   * Merge one rung of a ladder into the ladder the admin holds, and read back what it now holds.
   *
   * ⛔ Never throws but for one answer, exactly like {@link reportState} otherwise, and for the same
   * reason: the caller is a live announce path and a finalize, neither of which is improved by an
   * exception travelling up through it. The exception is the admin saying the stream does not exist,
   * thrown as {@link AdminStreamGoneError} because it is the one failure a finalize must not keep its
   * recovery entry for. `null` is the one failure value otherwise — the admin refused it, or could not
   * be reached across the whole ladder — and the caller turns that into a failed announce, which the
   * uploader re-attempts on `CATALOG_ANNOUNCE_RETRY_MS`. The merge is idempotent, so a whole report
   * repeating is safe.
   *
   * ⚠️ A 409 is not retried inside the ladder here, which is where this parts company with
   * `reportState`. The admin answers it for a stream that is still a draft or has a catalog write in
   * flight, so it means "not yet": retrying inside the ladder buys nothing for the first and the
   * announce cadence covers the second.
   *
   * @param id the admin's own id for the stream, which is the ladder rather than the rung.
   */
  public async reportRendition(id: string, rendition: Rendition): Promise<RenditionReportResponse | null> {
    const url = `${this.baseUrl}/api/internal/streams/${encodeURIComponent(id)}/renditions`;
    const body = JSON.stringify(rendition);

    for (let attempt = 1; attempt <= MAX_STATE_REPORT_ATTEMPTS; attempt++) {
      const outcome = await this.attemptRenditionReport(url, body, rendition.name, attempt);
      if (outcome === RENDITION_REPORT_STREAM_GONE) {
        throw new AdminStreamGoneError(id);
      }
      if (outcome !== RENDITION_REPORT_RETRY) {
        return outcome;
      }
      const wait = STATE_REPORT_BACKOFF_MS[attempt - 1];
      if (wait !== undefined) {
        await this.sleep(wait);
      }
    }

    this.logger.error(
      `[Admin] Gave up reporting rendition ${rendition.name} for stream ${id} after ` +
        `${MAX_STATE_REPORT_ATTEMPTS} attempts. The rung is publishing; the ladder the admin holds is ` +
        'missing it, so the master cannot be written from it until a later announce lands.',
    );
    return null;
  }

  /**
   * One attempt at a rendition report: the merged ladder, `null` for a settled refusal, or the retry
   * sentinel for a failure worth repeating.
   *
   * A sentinel rather than `null` for the retryable case, because `null` is already the value the
   * caller acts on and the two must not collide. Everything else mirrors {@link attemptReport}.
   */
  private async attemptRenditionReport(
    url: string,
    body: string,
    rung: string,
    attempt: number,
  ): Promise<RenditionReportResponse | null | typeof RENDITION_REPORT_RETRY | typeof RENDITION_REPORT_STREAM_GONE> {
    try {
      const response = await this.send(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        this.reportTimeoutMs,
      );

      if (response.ok) {
        // Screened rather than cast, because the rungs become the master playlist every viewer of the
        // broadcast resolves: a missing `topic` or `bandwidth` is a broadcast that publishes and cannot
        // be played, discovered by a viewer rather than here.
        const report = renditionReportAnswerSchema.safeParse(await this.readJson(response));
        if (!report.success) {
          this.logger.error(
            `[Admin] Report of rendition ${rung} answered 200 for ${url} with a body that is not a ladder`,
          );
          return null;
        }
        return report.data;
      }
      if (!isRetryableReportStatus(response.status)) {
        this.logger.error(`[Admin] Report of rendition ${rung} refused with ${response.status} for ${url}`);
        return isStreamNotFound(response.status, await this.readJson(response)) ? RENDITION_REPORT_STREAM_GONE : null;
      }
      this.logger.warn(
        `[Admin] Report of rendition ${rung} answered ${response.status} for ${url}, attempt ${attempt}`,
      );
      return RENDITION_REPORT_RETRY;
    } catch (error) {
      this.logger.warn(
        `[Admin] Report of rendition ${rung} to ${url} did not complete on attempt ${attempt}: ${getErrorMessage(
          error,
        )}`,
      );
      return RENDITION_REPORT_RETRY;
    }
  }

  /**
   * One attempt at a report, or null when the attempt failed in a way that is worth repeating.
   *
   * Null rather than a thrown error for the retryable case, so the loop above reads as the policy it
   * is. A 4xx other than a 409 from a stream in passing ends the loop immediately: a rejected token or
   * an unknown id does not become true by being asked again, and spending four seconds discovering
   * that delays a finalize.
   */
  private async attemptReport(
    url: string,
    body: string,
    report: AdminStateReport,
    attempt: number,
  ): Promise<StateReportOutcome | null> {
    try {
      const response = await this.send(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        this.reportTimeoutMs,
      );

      if (response.ok) {
        return STATE_REPORT_ACCEPTED;
      }
      if (response.status === 409) {
        // A draft refuses for good. Any other state is one the stream is passing through: `publishing`
        // while a republish or unpublish holds it, or the state another report wrote first when two
        // raced. Both let the next attempt through.
        const holds = heldStateOf(await this.readJson(response));
        if (holds === ADMIN_STATUS_DRAFT) {
          this.logger.error(
            `[Admin] Refused the ${report.state} report for ${url}: the stream is a draft on the admin, ` +
              'unpublished or never published, so it is not listed. Publish it on the admin to list the broadcast.',
          );
          return STATE_REPORT_FAILED;
        }
        this.logger.warn(
          `[Admin] Refused the ${report.state} report for ${url} while the stream is ${holds ?? 'in another state'}, ` +
            `attempt ${attempt}. Asking again.`,
        );
        return null;
      }
      if (!isRetryableReportStatus(response.status)) {
        this.logger.error(`[Admin] Report of ${report.state} refused with ${response.status} for ${url}`);
        return isStreamNotFound(response.status, await this.readJson(response))
          ? STATE_REPORT_STREAM_GONE
          : STATE_REPORT_FAILED;
      }
      this.logger.warn(`[Admin] Report of ${report.state} answered ${response.status} for ${url}, attempt ${attempt}`);
      return null;
    } catch (error) {
      // A timeout, a refused connection, a DNS failure: the admin was not reachable at all, which is
      // the case the retry ladder exists for.
      this.logger.warn(
        `[Admin] Report of ${report.state} to ${url} did not complete on attempt ${attempt}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * One request, with the bearer token and an abort window on it.
   *
   * `AbortSignal.timeout` rather than a timer of our own, because node's fetch has no default
   * timeout at all: a connection the admin accepts and then holds open would otherwise stall a
   * publish gate for as long as the socket lives, which is exactly the failure
   * `BEE_REQUEST_TIMEOUT_MS` was added for on the bee side.
   */
  private send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.sendPublic(
      url,
      { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` } },
      timeoutMs,
    );
  }

  /**
   * One request without the token, for the admin's public pages. A page that answers anyone gains
   * nothing from it, and any proxy in between that logs headers would record it.
   */
  private sendPublic(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  /** A body that is not JSON is a body that is not a draft, and the caller says so for both. */
  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
