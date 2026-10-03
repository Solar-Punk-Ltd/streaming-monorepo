/**
 * The stage routes, for the mock manager: a deployment's public ingest address
 * and how the manager's last push of its stage record into the web2 admin went,
 * in the shapes `manager/src/api/routes/profiles.ts` and `routes/stages.ts`
 * answer.
 *
 * The mock pushes nothing. A running stage reads as registered at the last
 * 30-second mark, the cadence the manager pushes on, and any other stage as
 * registered when it last changed. A stage whose name carries `offline` reads
 * as `unreachable`, so the page's line can be seen in a failing state too.
 *
 * The records `GET /stages` answers, which the console's Stages page lists,
 * carry the readiness the manager works out, from the same composition, and
 * the uploader's token by its kind: none for a stage whose name carries
 * `standalone`, which is linked to no admin of the manager's, a shared one for
 * one whose name carries `legacy`, as a deployment made before tokens of their
 * own presents, and its own for any other.
 */
import {
  ADMIN_TOKEN_ROTATED_MESSAGE,
  ingestHostProblem,
  isPublicPortVar,
  isStageKind,
  readinessInputOf,
  resolvedIngestHost,
  stageReadinessOf,
} from '@streaming-infra-manager/common';

import { PORT_BASES } from './mock-seed.mjs';

const INTERVAL_MS = 30_000;

/** The last push of one stage, as the manager keeps it in memory. */
function lastPushOf(profile, now = Date.now()) {
  if (!isStageKind(profile.kind)) return null;
  const outcome = profile.name.includes('offline') ? 'unreachable' : 'stored';
  const at = profile.status === 'RUNNING' ? now - (now % INTERVAL_MS) : Date.parse(profile.updated_at);
  return { outcome, at: new Date(at).toISOString() };
}

/** The token a stage's uploader presents, by its kind alone, as `GET /stages` answers it. */
function adminTokenOf(profile) {
  if (profile.name.includes('standalone')) return null;
  return { kind: profile.name.includes('legacy') ? 'shared' : 'own' };
}

/** The record `GET /stages` answers for one stage, without its passphrase, as the manager would build it. */
function consoleStageOf(profile, publicHost, managerId) {
  const engine = (profile.components ?? []).includes('ome') ? 'ome' : 'srs';
  return {
    name: profile.name,
    record: {
      schemaVersion: 1,
      stageId: profile.instance_id,
      managerId,
      name: profile.name,
      kind: profile.kind,
      engine,
      stackVersion: null,
      status: profile.status,
      observedAt: new Date().toISOString(),
      ingest: {
        host: resolvedIngestHost(profile, publicHost),
        srtPort: PORT_BASES.SRS_SRT_PORT + profile.port_slot * 10,
        rtmpPort: PORT_BASES.SRS_RTMP_PORT + profile.port_slot * 10,
        // As the manager decides it: SRS only, and only where the port policy opens RTMP, which it does not by default.
        rtmpPublic: engine === 'srs' && isPublicPortVar('SRS_RTMP_PORT'),
        hasSrtPassphrase: profile.has_srt_passphrase,
      },
      owner: profile.public_key ?? `0x${'0'.repeat(40)}`,
      rungs: [],
      uploader: null,
      readiness: stageReadinessOf(readinessInputOf(profile)),
      adminToken: adminTokenOf(profile),
    },
    problem: null,
    lastPush: lastPushOf(profile),
  };
}

/**
 * @param {{
 *   readBody: (req: import('node:http').IncomingMessage) => Promise<Record<string, unknown>>,
 *   withProfile: Function,
 *   profiles: () => Array<Record<string, any>>,
 *   changed: (profile: Record<string, any>) => void,
 *   publicHost: string,
 *   send: (res: import('node:http').ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void,
 * }} helpers
 */
export function stageRoutes({ readBody, withProfile, profiles, changed, publicHost, send }) {
  const managerId = '00000000-0000-4000-8000-00000000cafe';
  return [
    [
      'PATCH',
      /^\/profiles\/([^/]+)\/ingest-host$/,
      withProfile(async (req, res, profile) => {
        const body = await readBody(req);
        if (!('ingest_host' in body)) {
          return send(res, 400, { error: 'validation_error', errors: ['ingest_host is a required field'] });
        }
        const value = typeof body.ingest_host === 'string' && body.ingest_host.trim() !== '' ? body.ingest_host : null;
        const problem = value === null ? null : ingestHostProblem(value);
        if (problem) return send(res, 400, { error: 'validation_error', errors: [`ingest_host: ${problem}`] });
        profile.ingest_host = value;
        profile.updated_at = new Date().toISOString();
        changed(profile);
        return send(res, 200, profile);
      }),
    ],
    [
      // Rotate the uploader's admin token. A stage whose name carries `standalone` has no link, and is refused the
      // way the manager refuses one whose next deploy would generate no token of its own.
      'POST',
      /^\/profiles\/([^/]+)\/admin-token\/rotate$/,
      withProfile(async (_req, res, profile) => {
        if (!isStageKind(profile.kind)) {
          return send(res, 400, {
            error: 'validation_error',
            errors: ['This deployment runs no stream uploader, so it has no admin token to rotate.'],
            name: profile.name,
          });
        }
        if (profile.name.includes('standalone')) {
          return send(res, 400, {
            error: 'validation_error',
            errors: [
              "The uploader is given another address than the manager's web2 admin link, so its next deploy would generate no ADMIN_API_TOKEN of its own. Change ADMIN_API_TOKEN on the Stack settings card instead.",
            ],
            name: profile.name,
          });
        }
        profile.updated_at = new Date().toISOString();
        changed(profile);
        return send(res, 200, { message: ADMIN_TOKEN_ROTATED_MESSAGE }, { 'cache-control': 'no-store' });
      }),
    ],
    [
      'GET',
      /^\/stages\/([^/]+)\/registration$/,
      (_req, res, params) => {
        const profile = profiles().find((entry) => entry.name === params[0]);
        send(res, 200, { registration: profile ? lastPushOf(profile) : null }, { 'cache-control': 'no-store' });
      },
    ],
    [
      'GET',
      /^\/stages$/,
      (_req, res) => {
        const stages = profiles()
          .filter((profile) => isStageKind(profile.kind))
          .map((profile) => consoleStageOf(profile, publicHost, managerId));
        send(res, 200, { stages }, { 'cache-control': 'no-store' });
      },
    ],
  ];
}
