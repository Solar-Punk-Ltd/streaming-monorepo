/**
 * Where a deployment page puts the SRT passphrase for OBS.
 *
 * OBS reads its Server line with FFmpeg, which ends a value at `&`, turns `+`
 * into a space and never percent-decodes. A passphrase made only of letters,
 * digits and `. _ ~ -` rides on the line. Any other goes in OBS's own
 * passphrase field, with the same words the admin console uses, because a line
 * carrying it would connect with the wrong passphrase or not at all.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, PAGE_TEXT, waitFor } from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));

const OBS_FIELD_WORDS =
  'This passphrase has characters the Server line cannot carry. In OBS, tick Use authentication, leave Username empty and paste this into Password.';

function stage(name, portSlot) {
  return {
    name,
    kind: 'streamer',
    status: 'RUNNING',
    port_slot: portSlot,
    host: 'localhost',
    notes: null,
    last_error: null,
    last_error_at: null,
    created_at: '2026-09-28T06:00:00Z',
    updated_at: '2026-09-28T06:00:00Z',
    engine_settings: {},
    has_engine_config: false,
    engine_config_error: null,
    intent_revision: 1,
    has_srt_passphrase: true,
    stamp_id: null,
    public_key: '1'.repeat(40),
    pendingStamp: false,
    containers: [{ service: 'srs', ports: { SRS_SRT_PORT: 10001 + portSlot * 10 } }],
  };
}

const passphrases = { 'plain-stage': 'plain.pass_word~-1', 'awkward-stage': 'p&ss word#1' };
const profiles = [stage('plain-stage', 1), stage('awkward-stage', 2)];

test('a deployment page puts an SRT passphrase on the line only when the line can carry it', async (t) => {
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('publish-passphrase'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [
      {
        name: 'offline-publish-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            const path = req.url?.split('?')[0];
            const json = (body, status = 200) => {
              res.writeHead(status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(body));
            };
            if (path === '/auth/session')
              return json({ username: 'publish-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
            if (path === '/profiles') return json({ profiles });
            if (path === '/groups') return json({ groups: [] });
            if (path === '/versions') return json([]);
            if (path === '/versions/attempts') return json({ attempts: [] });
            if (path === '/config')
              return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
            if (path === '/events' || path?.startsWith('/metrics')) {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.write(': offline fixture\n\n');
              return;
            }
            const reveal = path?.match(/^\/profiles\/([^/]+)\/srt-passphrase$/);
            if (reveal) return json({ srt_passphrase: passphrases[decodeURIComponent(reveal[1])] ?? null });
            if (path?.startsWith('/profiles/'))
              return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
            return next();
          });
        },
      },
    ],
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { call, evaluate } = await launchChrome(t, origin);
  // Every CopyBox is its value followed by its Copy button.
  const copyBoxValues = `[...document.querySelectorAll('button')].filter(node => node.textContent === 'Copy').map(node => node.previousElementSibling?.textContent ?? '')`;

  await t.test('a passphrase of letters, digits and . _ ~ - rides on the line', async () => {
    await call('Page.navigate', { url: `${origin}/#/deployments/plain-stage` });
    const text = await waitFor(
      () => evaluate(PAGE_TEXT),
      (body) => body.includes('Publish') && body.includes("this deployment's own passphrase"),
      'the plain stage publish card',
    );
    const values = await evaluate(copyBoxValues);
    assert.ok(
      values.includes('srt://offline.example:10011?streamid=#!::r=live/stream,m=publish&passphrase=plain.pass_word~-1'),
      `the line carries the passphrase, got ${JSON.stringify(values)}`,
    );
    assert.ok(!text.includes(OBS_FIELD_WORDS), 'nothing asks for the passphrase field');
  });

  await t.test("any other passphrase goes in OBS's own field, in the admin's words", async () => {
    await call('Page.navigate', { url: `${origin}/#/deployments/awkward-stage` });
    const text = await waitFor(
      () => evaluate(PAGE_TEXT),
      (body) => body.includes(OBS_FIELD_WORDS),
      "the awkward stage's passphrase field wording",
    );
    const values = await evaluate(copyBoxValues);
    assert.ok(
      values.includes('srt://offline.example:10021?streamid=#!::r=live/stream,m=publish'),
      `the line carries no passphrase, got ${JSON.stringify(values)}`,
    );
    assert.ok(values.includes('p&ss word#1'), 'the passphrase itself is offered to copy into that field');
    assert.ok(!values.some((value) => value.includes('passphrase=')), 'no line carries a cut passphrase');
    assert.ok(!text.includes('already in the URL'), 'the page does not claim the line carries it');
  });
});
