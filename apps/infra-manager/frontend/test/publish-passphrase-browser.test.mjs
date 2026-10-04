/**
 * Where a deployment page puts the SRT passphrase for OBS, and that an SRS
 * deployment offers RTMP beside the SRT line while an OvenMediaEngine one does not.
 *
 * OBS reads its Server line with FFmpeg, which ends a value at `&`, turns `+`
 * into a space and never percent-decodes. A passphrase made only of letters,
 * digits and `. _ ~ -` rides on the line. Any other goes in OBS's own
 * passphrase field, with the same words the admin console uses, because a line
 * carrying it would connect with the wrong passphrase or not at all. SRS takes
 * RTMP as well, so its deployments offer the RTMP boxes with their warning and
 * Copy publish URL copies both. OvenMediaEngine takes SRT alone.
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
    // The ingest alone, so the only readiness step is its container running and the list offers Copy.
    components: ['srs'],
    containers: [{ service: 'srs', ports: { SRS_SRT_PORT: 10001 + portSlot * 10 } }],
  };
}

const passphrases = { 'plain-stage': 'plain.pass_word~-1', 'awkward-stage': 'p&ss word#1' };

/** An OvenMediaEngine deployment, whose ingest takes SRT alone. */
const omeStage = {
  ...stage('ome-stage', 3),
  has_srt_passphrase: false,
  components: ['ome'],
  containers: [{ service: 'ome', ports: { OME_SRT_PORT: 10031 } }],
};
const profiles = [stage('plain-stage', 1), stage('awkward-stage', 2), omeStage];

const RTMP_WARNING_START = 'RTMP is not encrypted';

/** How many times a value appears in a text. */
const occurrences = (text, value) => text.split(value).length - 1;

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
    assert.ok(values.includes('rtmp://offline.example:10012/live'), `the RTMP server, got ${JSON.stringify(values)}`);
    assert.ok(text.includes(RTMP_WARNING_START), 'the RTMP warning beside RTMP');
    assert.ok(text.includes('Stream Key'), 'the RTMP stream key box');
    assert.equal(
      occurrences(text, passphrases['plain-stage']),
      1,
      'the passphrase is on the page in the SRT line alone, because RTMP carries none',
    );
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
    assert.ok(values.includes('rtmp://offline.example:10022/live'), `the RTMP server, got ${JSON.stringify(values)}`);
    assert.equal(
      occurrences(text, passphrases['awkward-stage']),
      1,
      "the passphrase is on the page in OBS's field alone",
    );
  });

  await t.test('an OvenMediaEngine deployment offers SRT alone, with no RTMP and no warning', async () => {
    await call('Page.navigate', { url: `${origin}/#/deployments/ome-stage` });
    const text = await waitFor(
      () => evaluate(PAGE_TEXT),
      (body) => body.includes('Publish') && body.includes('OvenMediaEngine ingest'),
      'the OvenMediaEngine publish card',
    );
    const values = await evaluate(copyBoxValues);
    assert.ok(
      values.some((value) => value.startsWith('srt://offline.example:10031')),
      JSON.stringify(values),
    );
    assert.ok(!values.some((value) => value.startsWith('rtmp://')), `no RTMP server, got ${JSON.stringify(values)}`);
    assert.ok(!text.includes(RTMP_WARNING_START), 'no RTMP warning without RTMP');
  });

  // The list's Copy button asks for the passphrase on the click. A line copied
  // without it connects in OBS and is refused by the ingest with nothing on
  // either screen, so for that passphrase the click opens the deployment page.
  // The overview's Copy is the same `usePublishUrl` copy, and it lists only
  // stream deployments, whose readiness needs an uploader this fixture has not.
  const stubClipboard = `window.copiedPublishUrl = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedPublishUrl = value; } } })`;
  const copyIn = (name) =>
    `[...document.querySelectorAll('tr')].find(row => row.innerText.includes(${JSON.stringify(name)}))?.querySelector('button') && [...[...document.querySelectorAll('tr')].find(row => row.innerText.includes(${JSON.stringify(name)})).querySelectorAll('button')].find(button => button.textContent.trim() === 'Copy publish URL')`;

  for (const [page, hash] of [['deployments list', '#/deployments']]) {
    await t.test(`the ${page} copies a line that carries its passphrase`, async () => {
      await call('Page.navigate', { url: `${origin}/${hash}` });
      await waitFor(() => evaluate(`!!(${copyIn('plain-stage')})`), Boolean, `the plain stage Copy on the ${page}`);
      await evaluate(stubClipboard);
      await evaluate(`(${copyIn('plain-stage')}).click()`);
      const copied = await waitFor(
        () => evaluate('window.copiedPublishUrl ?? null'),
        Boolean,
        'the copied plain stage line',
      );
      // SRS takes RTMP too, so its server and stream key follow the SRT line.
      assert.equal(
        copied,
        [
          'SRT: srt://offline.example:10011?streamid=#!::r=live/stream,m=publish&passphrase=plain.pass_word~-1',
          'RTMP Server: rtmp://offline.example:10012/live',
          'RTMP Stream Key: stream',
        ].join('\n'),
      );
      assert.equal(await evaluate('location.hash'), hash);
    });

    await t.test(`the ${page} opens the deployment page for a passphrase the line cannot carry`, async () => {
      await call('Page.navigate', { url: `${origin}/${hash}` });
      await waitFor(() => evaluate(`!!(${copyIn('awkward-stage')})`), Boolean, `the awkward stage Copy on the ${page}`);
      await evaluate(stubClipboard);
      await evaluate(`(${copyIn('awkward-stage')}).click()`);
      await waitFor(
        () => evaluate('location.hash'),
        (value) => value === '#/deployments/awkward-stage',
        'the deployment page',
      );
      await waitFor(
        () => evaluate(PAGE_TEXT),
        (body) => body.includes(OBS_FIELD_WORDS),
        'the passphrase field wording',
      );
      assert.equal(
        await evaluate('window.copiedPublishUrl ?? null'),
        null,
        'no line without its passphrase was copied',
      );
    });
  }
});
