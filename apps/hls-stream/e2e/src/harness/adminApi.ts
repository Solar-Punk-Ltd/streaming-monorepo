/**
 * Driving a stage that runs in admin mode, where every broadcast is a stream an operator declared in the web2 admin.
 *
 * ## Why admin mode needs its own runner
 *
 * Every other suite here publishes standalone: the uploader mints a fresh ladder group per broadcast, so no rung topic
 * is ever reused. Admin mode reuses the declared stream's topic for every broadcast on it, and that is the only place
 * the 2026-10-14 re-broadcast defect could live. So a suite that wants it has to declare a stream, publish it to the
 * catalogue, read its ingest key and broadcast to `<mediaType>/<topic>` the way OBS would.
 *
 * ## ⛔⛔ The token
 *
 * The admin's operator routes are behind a session cookie, `web2_admin_session`, which `POST /api/auth/login` sets.
 * This harness never logs in and never sees a password. `E2E_ADMIN_TOKEN` is the session token, read from the process
 * environment and from nowhere else: no env file, no profile, no argument. It is meant to arrive through `op run` with
 * an `op://` reference, so it exists only in this process for the length of the run. It is put on the Cookie header and
 * nowhere else, and no error, log line or summary built here carries it or any header.
 *
 * Writes also carry `x-requested-with: web2-admin`, the header the admin's cross-site gate requires of every write.
 * Both names are copied from `apps/web2-admin/common/src/auth.ts`, because this package depends on nothing of the
 * admin's, and `test/adminApi.test.ts` reads them back out of that file so a rename there fails here.
 *
 * ## Skipped loudly, never passed
 *
 * A suite that needs admin mode reads {@link adminModeFrom} at module scope and skips with the reason it returns.
 * `node --test` prints a skipped suite as skipped, so a run without the config says so rather than reporting the
 * admin scenarios green.
 */

import { INGEST_RTMP, INGEST_SRT, type IngestProtocol } from '../ingestProtocol.js';

import { messageText } from './logwatch.js';

/** The cookie the admin keeps an operator's session in. Mirrors `SESSION_COOKIE_NAME`. */
export const ADMIN_SESSION_COOKIE = 'web2_admin_session';
/** The header and value every admin write must carry. Mirror `REQUESTED_WITH_HEADER` and `REQUESTED_WITH_VALUE`. */
export const ADMIN_WRITE_HEADER = 'x-requested-with';
export const ADMIN_WRITE_VALUE = 'web2-admin';

export const ADMIN_API_URL_VAR = 'E2E_ADMIN_API_URL';
export const ADMIN_STREAM_ID_VAR = 'E2E_ADMIN_STREAM_ID';
export const ADMIN_STAGE_ID_VAR = 'E2E_ADMIN_STAGE_ID';
export const ADMIN_EXPIRED_STREAM_ID_VAR = 'E2E_ADMIN_EXPIRED_STREAM_ID';
export const ADMIN_TOKEN_VAR = 'E2E_ADMIN_TOKEN';

/** What an admin-mode run was given. Every id is a stream or stage UUID as the admin names it. */
export interface AdminMode {
  apiUrl: string;
  token: string;
  /** A declared stream on the stage under test, broadcast to again and again. */
  streamId: string | null;
  /** The stage a suite declares a throwaway stream on, for the lifecycle suite that deletes what it made. */
  stageId: string | null;
  /** A declared stream whose first session's postage batch has already expired. See scenario G3. */
  expiredStreamId: string | null;
}

/** What a suite needs out of the config beyond the url and the token. */
export type AdminNeed = 'stream' | 'stage' | 'expired';

const NEEDS: Record<AdminNeed, { field: 'streamId' | 'stageId' | 'expiredStreamId'; variable: string }> = {
  stream: { field: 'streamId', variable: ADMIN_STREAM_ID_VAR },
  stage: { field: 'stageId', variable: ADMIN_STAGE_ID_VAR },
  expired: { field: 'expiredStreamId', variable: ADMIN_EXPIRED_STREAM_ID_VAR },
};

function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The admin-mode config out of the process environment, or null for every field it does not carry. */
export function adminModeFrom(env: NodeJS.ProcessEnv): Partial<AdminMode> {
  return {
    apiUrl: present(env[ADMIN_API_URL_VAR])?.replace(/\/+$/, '') ?? undefined,
    token: present(env[ADMIN_TOKEN_VAR]) ?? undefined,
    streamId: present(env[ADMIN_STREAM_ID_VAR]),
    stageId: present(env[ADMIN_STAGE_ID_VAR]),
    expiredStreamId: present(env[ADMIN_EXPIRED_STREAM_ID_VAR]),
  };
}

/**
 * The reason an admin suite skips, or false to run. Names every variable that is missing and never a value.
 *
 * ⛔ A skip, not a failure, because an ordinary run against a standalone stage is right not to have any of this. It is
 * printed as skipped by `node --test`, which is what keeps it from passing silently.
 */
export function adminSkipReason(mode: Partial<AdminMode>, needs: readonly AdminNeed[]): string | false {
  const missing = [
    ...(mode.apiUrl === undefined ? [ADMIN_API_URL_VAR] : []),
    ...(mode.token === undefined ? [ADMIN_TOKEN_VAR] : []),
    ...needs.filter((need) => mode[NEEDS[need].field] == null).map((need) => NEEDS[need].variable),
  ];
  if (missing.length === 0) {
    return false;
  }
  return (
    `SKIPPED, NOT PASSED: this suite needs a stage in admin mode and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
    `not set. Run it on the stage with ${ADMIN_TOKEN_VAR} supplied by op run, see the e2e README`
  );
}

/** Narrows a config whose skip reason was false. */
export function requireAdminMode(mode: Partial<AdminMode>): AdminMode {
  if (mode.apiUrl === undefined || mode.token === undefined) {
    throw new Error(`${ADMIN_API_URL_VAR} and ${ADMIN_TOKEN_VAR} must both be set to drive the admin`);
  }
  return {
    apiUrl: mode.apiUrl,
    token: mode.token,
    streamId: mode.streamId ?? null,
    stageId: mode.stageId ?? null,
    expiredStreamId: mode.expiredStreamId ?? null,
  };
}

/** The admin's stream row, as far as these suites read it. See `Stream` in `apps/web2-admin/common/src/api.ts`. */
export interface AdminStream {
  id: string;
  topic: string;
  owner: string;
  title: string;
  mediaType: 'video' | 'audio';
  status: 'draft' | 'publishing' | 'published' | 'live' | 'vod';
  publishedFeedIndex: number | null;
  manifestIndex?: number | null;
  durationSeconds?: number | null;
  stageId?: string | null;
}

/** OBS connection details. See `IngestDetails` in `apps/web2-admin/common/src/ingest.ts`. */
export interface AdminIngest {
  streamId: string;
  app: 'video' | 'audio';
  stream: string;
  srt: { url: string; passphrase: string | null } | null;
  rtmp: { server: string; streamKey: string } | null;
}

/** `POST /api/streams/:id/publish` and `/unpublish` answer this. See `PublishResult`. */
export interface AdminPublishResult {
  stream: AdminStream;
  feed: { owner: string; topic: string; topicHex: string; index: number; entryCount: number };
  written: boolean;
}

/** An admin answer that was not a success: the status and the error code the admin's error handler wrote. */
export class AdminRefusal extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`the admin answered ${status}${code === null ? '' : ` ${code}`} to ${route}`);
    this.name = 'AdminRefusal';
  }
}

/** What a broadcaster dials for a declared stream, and over which protocol. */
export interface AdminIngestTarget {
  url: string;
  protocol: IngestProtocol;
}

/**
 * The URL ffmpeg publishes to, out of the details the admin hands OBS.
 *
 * RTMP where the stage offers it, because it needs no passphrase, so the one secret a stage's ingest has never reaches
 * this process's URL. SRT only where RTMP is absent, with the passphrase appended the way the admin's own OBS helper
 * puts it on the Server line. Null where the stream has no stage and so nowhere to send it.
 */
export function adminIngestTarget(
  ingest: AdminIngest,
  preferred: IngestProtocol = INGEST_RTMP,
): AdminIngestTarget | null {
  const rtmp: AdminIngestTarget | null =
    ingest.rtmp === null ? null : { url: `${ingest.rtmp.server}/${ingest.rtmp.streamKey}`, protocol: INGEST_RTMP };
  const srt: AdminIngestTarget | null =
    ingest.srt === null
      ? null
      : {
          url:
            ingest.srt.passphrase === null ? ingest.srt.url : `${ingest.srt.url}&passphrase=${ingest.srt.passphrase}`,
          protocol: INGEST_SRT,
        };
  return preferred === INGEST_SRT ? (srt ?? rtmp) : (rtmp ?? srt);
}

/** The error code out of an admin error body, which is `{ error: <code>, ... }`, or null. */
export function adminErrorCode(body: unknown): string | null {
  return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : null;
}

/** The headers one request carries. The token goes on the cookie and nowhere else. */
export function adminHeaders(token: string, write: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
    ...(write ? { [ADMIN_WRITE_HEADER]: ADMIN_WRITE_VALUE, 'content-type': 'application/json' } : {}),
  };
}

const ADMIN_REQUEST_TIMEOUT_MS = 30_000;

/** The admin's operator routes, as one signed-in operator calls them. */
export class AdminApi {
  constructor(
    private readonly mode: Pick<AdminMode, 'apiUrl' | 'token'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const write = method !== 'GET';
    const response = await this.fetcher(`${this.mode.apiUrl}${route}`, {
      method,
      headers: adminHeaders(this.mode.token, write),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed: unknown = text === '' ? null : JSON.parse(text);
    if (!response.ok) {
      throw new AdminRefusal(`${method} ${route}`, response.status, adminErrorCode(parsed));
    }
    return parsed as T;
  }

  getStream(id: string): Promise<AdminStream> {
    return this.call('GET', `/api/streams/${encodeURIComponent(id)}`);
  }

  async listStreams(): Promise<AdminStream[]> {
    return (await this.call<{ streams: AdminStream[] }>('GET', '/api/streams')).streams;
  }

  /** Declares a throwaway video stream on a stage, scheduled for now. */
  createStream(title: string, stageId: string): Promise<AdminStream> {
    return this.call('POST', '/api/streams', {
      title,
      description: 'Declared by the e2e harness, deleted at the end of its suite',
      tags: ['e2e'],
      mediaType: 'video',
      scheduledStartTime: new Date().toISOString(),
      stageId,
    });
  }

  publish(id: string): Promise<AdminPublishResult> {
    return this.call('POST', `/api/streams/${encodeURIComponent(id)}/publish`);
  }

  unpublish(id: string): Promise<AdminPublishResult> {
    return this.call('POST', `/api/streams/${encodeURIComponent(id)}/unpublish`);
  }

  async deleteStream(id: string): Promise<void> {
    await this.call('DELETE', `/api/streams/${encodeURIComponent(id)}`);
  }

  ingest(id: string): Promise<AdminIngest> {
    return this.call('GET', `/api/streams/${encodeURIComponent(id)}/ingest`);
  }
}

/** The ingest stream id the uploader sees for a declared stream, `<mediaType>/<topic>`. */
export function declaredStreamPath(stream: Pick<AdminStream, 'mediaType' | 'topic'>): string {
  return `${stream.mediaType}/${stream.topic}`;
}

const ADMIN_UNREACHABLE_LINE = /refused (\S+): the admin API did not resolve it/g;

/** Every ingest id the uploader refused because the admin did not answer its lookup. See `engines/adminGate.ts`. */
export function adminUnreachableRefusals(logText: string): string[] {
  return [...messageText(logText).matchAll(ADMIN_UNREACHABLE_LINE)].map((match) => match[1]);
}
