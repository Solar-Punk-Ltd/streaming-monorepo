import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_WRITE_HEADER,
  ADMIN_WRITE_VALUE,
  AdminApi,
  adminIngestTarget,
  adminModeFrom,
  AdminRefusal,
  adminSkipReason,
  adminUnreachableRefusals,
  declaredStreamPath,
} from '../src/harness/adminApi.js';

/**
 * The admin-mode runner, without an admin.
 *
 * ⛔ The cookie and header names are read back out of the admin's own source rather than restated, because this
 * package depends on nothing of the admin's and a rename there would otherwise leave every admin suite answered 401 or
 * 403 on the stage, reading as a broken admin rather than a stale harness.
 */

const MONOREPO_DIR = join(ROOT_DIR, '..', '..');
const TOKEN = 'session-token-that-must-never-be-printed';

function declaredConstant(file: string, name: string): string | null {
  const source = readFileSync(join(MONOREPO_DIR, file), 'utf8');
  return new RegExp(`export const ${name} = '([^']+)'`).exec(source)?.[1] ?? null;
}

describe('the names the admin authenticates by', () => {
  it('match the admin source', () => {
    assert.equal(declaredConstant('apps/web2-admin/common/src/auth.ts', 'SESSION_COOKIE_NAME'), ADMIN_SESSION_COOKIE);
    assert.equal(declaredConstant('apps/web2-admin/common/src/auth.ts', 'REQUESTED_WITH_VALUE'), ADMIN_WRITE_VALUE);
    assert.equal(declaredConstant('packages/web-auth/src/rules.ts', 'REQUESTED_WITH_HEADER'), ADMIN_WRITE_HEADER);
  });
});

describe('adminModeFrom and adminSkipReason', () => {
  it('skips loudly, naming every missing variable and no value', () => {
    const reason = adminSkipReason(adminModeFrom({ E2E_ADMIN_TOKEN: TOKEN }), ['stream']);
    assert.match(String(reason), /^SKIPPED, NOT PASSED/);
    assert.match(String(reason), /E2E_ADMIN_API_URL, E2E_ADMIN_STREAM_ID are not set/);
    assert.ok(!String(reason).includes(TOKEN));
  });

  it('runs when everything a suite needs is there, and drops a trailing slash off the url', () => {
    const mode = adminModeFrom({
      E2E_ADMIN_API_URL: 'https://admin.example.com/',
      E2E_ADMIN_TOKEN: TOKEN,
      E2E_ADMIN_STREAM_ID: 'c0ffee00-0000-4000-8000-000000000001',
    });
    assert.equal(adminSkipReason(mode, ['stream']), false);
    assert.equal(mode.apiUrl, 'https://admin.example.com');
    assert.notEqual(adminSkipReason(mode, ['expired']), false);
  });

  it('reads a blank variable as missing', () => {
    assert.notEqual(adminSkipReason(adminModeFrom({ E2E_ADMIN_API_URL: ' ', E2E_ADMIN_TOKEN: TOKEN }), []), false);
  });
});

describe('adminIngestTarget', () => {
  const ingest = {
    streamId: 'video/topic-a',
    app: 'video' as const,
    stream: 'topic-a',
    srt: { url: 'srt://ingest.example.com:10061?streamid=#!::r=video/topic-a?key=k,m=publish', passphrase: 'pp' },
    rtmp: { server: 'rtmp://ingest.example.com:10062/video', streamKey: 'topic-a?key=k' },
  };

  it('prefers RTMP, which carries no passphrase', () => {
    assert.deepEqual(adminIngestTarget(ingest), {
      url: 'rtmp://ingest.example.com:10062/video/topic-a?key=k',
      protocol: 'rtmp',
    });
  });

  it('puts the passphrase on an SRT url when that is all there is', () => {
    assert.match(adminIngestTarget({ ...ingest, rtmp: null })?.url ?? '', /m=publish&passphrase=pp$/);
  });

  it('answers null for a stream with no stage', () => {
    assert.equal(adminIngestTarget({ ...ingest, srt: null, rtmp: null }), null);
  });

  it('names the ingest id the uploader sees', () => {
    assert.equal(declaredStreamPath({ mediaType: 'video', topic: 'topic-a' }), 'video/topic-a');
  });
});

describe('AdminApi', () => {
  function recordingFetcher(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body === null ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  it('reads with the session cookie and without the write header', async () => {
    const { calls, fetcher } = recordingFetcher(200, { streams: [] });
    await new AdminApi({ apiUrl: 'https://admin.example.com', token: TOKEN }, fetcher).listStreams();
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(calls[0].url, 'https://admin.example.com/api/streams');
    assert.equal(headers.cookie, `${ADMIN_SESSION_COOKIE}=${TOKEN}`);
    assert.equal(headers[ADMIN_WRITE_HEADER], undefined);
  });

  it('writes with the header the cross-site gate requires', async () => {
    const { calls, fetcher } = recordingFetcher(200, { stream: {}, feed: {}, written: true });
    await new AdminApi({ apiUrl: 'https://admin.example.com', token: TOKEN }, fetcher).publish('id-1');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>)[ADMIN_WRITE_HEADER], ADMIN_WRITE_VALUE);
  });

  it('turns a refusal into the status and the admin error code, never the token', async () => {
    const { fetcher } = recordingFetcher(409, { error: 'stream_live', id: 'id-1' });
    const refused = await new AdminApi({ apiUrl: 'https://admin.example.com', token: TOKEN }, fetcher)
      .unpublish('id-1')
      .catch((error: unknown) => error);
    assert.ok(refused instanceof AdminRefusal);
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'stream_live');
    assert.ok(!refused.message.includes(TOKEN));
  });

  it('reads an empty success, which is what a delete answers', async () => {
    const { fetcher } = recordingFetcher(204, null);
    await new AdminApi({ apiUrl: 'https://admin.example.com', token: TOKEN }, fetcher).deleteStream('id-1');
  });
});

describe('adminUnreachableRefusals', () => {
  it('reads the refusal the admin gate writes when its lookup does not complete', () => {
    const log =
      '[2026-10-14T09:00:00.000Z] [ERROR] - [SRS] refused video/topic-a: the admin API did not resolve it ' +
      '(The operation was aborted due to timeout)';
    assert.deepEqual(adminUnreachableRefusals(log), ['video/topic-a']);
  });
});
