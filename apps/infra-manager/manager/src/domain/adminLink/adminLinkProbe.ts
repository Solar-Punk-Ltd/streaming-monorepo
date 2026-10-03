import { adminUrlProblem, type AdminLinkTestOutcome } from '@streaming-infra-manager/common';
import {
  ADMIN_ERROR_STREAM_NOT_FOUND,
  ADMIN_ERROR_UNAUTHENTICATED,
  feedOwnerOf,
  ingestLookupPath,
  MEDIA_TYPE_VIDEO,
  REGISTRAR_CHECK_PATH,
  sameFeedOwner,
  STAGE_SELF_PATH,
  stageSelfAnswerSchema,
} from '@streaming-monorepo/contracts';

import { judgePlainHttpAdminLink, type PlainHttpJudge } from './plainHttpAdminLink.js';

/**
 * What Test connection asks a web2 admin with: the address, the token, and whose token it is. `registrar` is the
 * manager's own, proved on the admin's registrar check; `uploader` is the one a deployment's uploader would be given,
 * proved on what the uploader asks.
 */
export interface AdminLinkProbeTarget {
  url: string;
  token: string;
  check: 'registrar' | 'uploader';
  /**
   * The address the deployment's stream key derives, compared with the owner the admin knows for an uploader's token's
   * stage, or with its catalog's for a token it ties to no stage. Null where there is none to compare, and never
   * compared for the registrar's token.
   */
  feedOwner: string | null;
}

export interface AdminLinkProbeOptions {
  /** How long each request may take in all: an uploader's check makes up to three, the registrar's up to two. */
  timeoutMs?: number;
  /** The most of a body that is read. The admin's own answers are a few hundred bytes. */
  maxBodyBytes?: number;
  /** The rule for plain http to another host than the manager's own. The manager's own when left out. */
  plainHttp?: PlainHttpJudge;
}

export type AdminLinkProbe = (
  target: AdminLinkProbeTarget,
  options?: AdminLinkProbeOptions,
) => Promise<AdminLinkTestOutcome>;

/** The stream uploader's own lookup timeout, `DEFAULT_LOOKUP_TIMEOUT_MS`, so an admin the uploader would give up on reads as unreachable here too. */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * The lookup the uploader makes on every publish, for a stream nobody can have
 * declared: the admin mints stream ids as random UUIDs and never the nil one.
 * `video` is one of the admin's two media types, because a lookup under any
 * other is refused before the admin looks. The admin checks the token before
 * anything else, so its own 404 for this path says it took the token.
 */
const UNUSED_STREAM_PATH = ingestLookupPath(`${MEDIA_TYPE_VIDEO}/00000000-0000-0000-0000-000000000000`);
const CONFIG_PATH = '/api/config';

/**
 * The owner the admin knows for the token's stage, off its answer to `GET /api/internal/stages/self`: the owner on a
 * 200 that names one, `no-stage` on a 404, which only an admin older than stages answers, or the intermediate admin
 * for the shared token, and null for anything else.
 */
function stageOwnerOf(answer: Answer): string | 'no-stage' | null {
  if (answer.kind !== 'answered') return null;
  if (answer.status === 404) return 'no-stage';
  if (answer.status !== 200) return null;
  const read = stageSelfAnswerSchema.safeParse(answer.body);
  return read.success ? read.data.owner : null;
}

/** What one request came to: no answer, a redirect, or a status with the body read as JSON, undefined when it was not JSON or ran past the bound. */
type Answer = { kind: 'none' } | { kind: 'redirect' } | { kind: 'answered'; status: number; body: unknown };

/**
 * Reads a body as JSON, up to the bound. Undefined for a body past the bound
 * or one that is not JSON. Throws only when the body stops arriving, which the
 * timeout ends.
 */
export async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (!response.body || (Number.isFinite(declared) && declared > maxBytes)) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    return undefined;
  }
}

/** One GET that follows no redirect, gives up at the timeout, and reads a bounded body. Nothing it met travels further than its kind. */
async function ask(url: string, headers: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<Answer> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
  } catch {
    return { kind: 'none' };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'redirect' };
  }
  try {
    return { kind: 'answered', status: response.status, body: await boundedJson(response, maxBytes) };
  } catch {
    return { kind: 'none' };
  }
}

function fieldOf(body: unknown, field: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[field] : undefined;
}

function errorCodeOf(answer: Answer): string | null {
  if (answer.kind !== 'answered') return null;
  const code = fieldOf(answer.body, 'error');
  return typeof code === 'string' ? code : null;
}

/** The address the admin signs its catalog with, off a 200 from its public config, or null. */
function configuredFeedOwner(answer: Answer): string | null {
  if (answer.kind !== 'answered' || answer.status !== 200) return null;
  return feedOwnerOf(answer.body);
}

/** The error code of the admin's 404 for a path no route names. */
const ADMIN_ERROR_NOT_FOUND = 'not_found';

/**
 * Proves the manager's own token, the admin's registrar token, on the admin's registrar check: 204 is `token-accepted`
 * and the admin's own 401 is `token-refused`. An admin older than the check answers its own 404 for the path only once
 * a token got past its door, so that 404 is followed by the uploader's lookup with the same token, which such an admin
 * still takes it on. An admin that has the check refuses the registrar token on the uploader's routes, so a lookup
 * would read it as refusing the token.
 */
async function probeRegistrar(
  base: string,
  token: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<AdminLinkTestOutcome> {
  const check = await ask(`${base}${REGISTRAR_CHECK_PATH}`, { authorization: `Bearer ${token}` }, timeoutMs, maxBytes);
  if (check.kind === 'none') return 'unreachable';
  if (check.kind === 'redirect') return 'redirected';
  if (check.status === 204) return 'token-accepted';
  if (check.status === 401 && errorCodeOf(check) === ADMIN_ERROR_UNAUTHENTICATED) return 'token-refused';
  if (check.status !== 404 || errorCodeOf(check) !== ADMIN_ERROR_NOT_FOUND) return 'not-admin';
  return lookupOutcome(
    await ask(`${base}${UNUSED_STREAM_PATH}`, { authorization: `Bearer ${token}` }, timeoutMs, maxBytes),
  );
}

/** What the uploader's lookup of a stream nobody declared says about the token, or null when the admin took it. */
function lookupRefusal(lookup: Answer): AdminLinkTestOutcome | null {
  if (lookup.kind === 'none') return 'unreachable';
  if (lookup.kind === 'redirect') return 'redirected';
  if (lookup.status === 401 && errorCodeOf(lookup) === ADMIN_ERROR_UNAUTHENTICATED) return 'token-refused';
  if (lookup.status !== 404 || errorCodeOf(lookup) !== ADMIN_ERROR_STREAM_NOT_FOUND) return 'not-admin';
  return null;
}

function lookupOutcome(lookup: Answer): AdminLinkTestOutcome {
  return lookupRefusal(lookup) ?? 'token-accepted';
}

/**
 * Asks a web2 admin what the holder of the token would ask it, and answers one
 * outcome code. The registrar's token is proved on the registrar check alone.
 * An uploader's token is proved on the lookup the uploader makes on every
 * publish. Where there is a stream address to compare, it then asks what the
 * uploader asks at boot: the stage the token belongs to, with the token, and
 * the owner the admin knows for it. Every stage signs with a key of its own,
 * so that owner is the one compared. On a 404 there, an admin older than
 * stages, it compares with the catalog owner of the public config, asked
 * without the token.
 *
 * It reaches whatever the manager's own host can reach, loopback and private
 * addresses included, as the uploader reaches whatever its host can. The
 * registrar's token goes in plain http only where the manager's pushes may,
 * to its own host, and is otherwise answered `plain-http-refused` unasked, or
 * `unreachable` for a name that does not resolve from the manager now. It
 * never throws, and nothing the far end sent reaches its answer.
 */
export const probeAdminLink: AdminLinkProbe = async (target, options = {}) => {
  if (adminUrlProblem(target.url) !== null) return 'invalid-address';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const base = target.url.replace(/\/+$/, '');
  if (target.check === 'registrar') {
    // The manager's own token goes where its pushes go, and nowhere its pushes would not.
    const plainHttp = await (options.plainHttp ?? judgePlainHttpAdminLink)(target.url);
    if (plainHttp === 'refused') return 'plain-http-refused';
    if (plainHttp === 'unresolved') return 'unreachable';
    return probeRegistrar(base, target.token, timeoutMs, maxBytes);
  }

  const refusal = lookupRefusal(
    await ask(`${base}${UNUSED_STREAM_PATH}`, { authorization: `Bearer ${target.token}` }, timeoutMs, maxBytes),
  );
  if (refusal !== null) return refusal;
  if (target.feedOwner === null) return 'token-accepted';

  const stage = stageOwnerOf(
    await ask(`${base}${STAGE_SELF_PATH}`, { authorization: `Bearer ${target.token}` }, timeoutMs, maxBytes),
  );
  if (stage === null) return 'owner-unconfirmed';
  if (stage !== 'no-stage') return sameFeedOwner(stage, target.feedOwner) ? 'linked' : 'owner-mismatch';

  const owner = configuredFeedOwner(await ask(`${base}${CONFIG_PATH}`, {}, timeoutMs, maxBytes));
  if (owner === null) return 'owner-unconfirmed';
  return sameFeedOwner(owner, target.feedOwner) ? 'linked' : 'owner-mismatch';
};
