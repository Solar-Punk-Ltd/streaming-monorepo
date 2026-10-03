/**
 * The ABR ladder's rung settings, edited from a deployment's settings card in
 * a real Chrome.
 *
 * A deployment that encodes the ladder lists each rung's width, height and
 * bitrate among its engine settings, grouped by rung, each with the shipped
 * ladder as the manager's own default. ABR_LADDER stays read-only, shows the
 * value the deployment gets and points at the rung settings. An odd size is
 * refused under its field, a rung out of order once above Save, and a save
 * sends only the rung keys that changed.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`,
 * or on its own: `node --import tsx --conditions=development --test test/abr-rung-settings-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  readWhenPresent,
  waitFor,
} from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';
import {
  ABR_LADDER_INSTANCE,
  abrLadderCatalog,
  afterSave,
  SHIPPED_ABR_LADDER,
} from './fixtures/deploymentSettings.mjs';
import { passingRejections } from './support/passing-rejections.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));

const LADDER = 'ladder-stage';
const NARROW = 390;

const PROFILE = {
  name: LADDER,
  kind: 'custom',
  status: 'RUNNING',
  port_slot: 1,
  host: 'localhost',
  instance_id: ABR_LADDER_INSTANCE,
  engine_config_revision: 0,
  intent_revision: 0,
  stack_version_id: 1,
  engine_config_state: null,
  engine_config_error: null,
  has_engine_config: false,
  notes: null,
  notes_revision: 0,
  last_error: null,
  last_error_at: null,
  has_srt_passphrase: false,
  created_at: '2026-09-30T08:00:00.000Z',
  updated_at: '2026-09-30T08:00:00.000Z',
  engine_settings: {},
  stamp_id: null,
  public_key: '1'.repeat(40),
  pendingStamp: false,
  containers: [
    { service: 'srs', ports: {} },
    { service: 'stream-uploader', ports: {} },
  ],
};

test('a ladder deployment edits each rung and shows the ABR_LADDER it gets', { timeout: 240_000 }, async (t) => {
  let catalog = abrLadderCatalog();
  const writes = [];

  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('abr-rung-settings'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [
      {
        name: 'offline-abr-rung-settings-fixture',
        configureServer(vite) {
          vite.middlewares.use(
            passingRejections(async (req, res, next) => {
              const path = req.url?.split('?')[0] ?? '';
              const json = (body, status = 200) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
              };
              if (!/^\/(auth|profiles|groups|config|events|metrics|versions)(\/|$)/.test(path)) return next();
              if (path === '/auth/session')
                return json({ username: 'ladder-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
              if (path === '/profiles') return json({ profiles: [PROFILE] });
              if (path === '/groups') return json({ groups: [] });
              if (path === '/versions') return json([]);
              if (path === '/versions/attempts') return json({ attempts: [] });
              if (path === '/config')
                return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
              if (path === '/events' || path.startsWith('/metrics')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(': offline fixture\n\n');
                return;
              }
              if (path === `/profiles/${LADDER}/settings`) {
                if (req.method === 'GET') return json(catalog);
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                writes.push(body);
                catalog = afterSave(catalog, body.entries);
                return json({ revision: catalog.revision });
              }
              if (path.startsWith('/profiles/'))
                return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
              return next();
            }),
          );
        },
      },
    ],
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { call, evaluate } = await launchChrome(t, origin);

  const card = `document.getElementById('stack-settings')`;
  const cardText = () => evaluate(`${card}?.innerText ?? ''`);
  const rowOf = (key) => `document.querySelector('li[data-setting="${key}"]')`;
  const fieldOf = (key) => `document.getElementById('deployment-setting-${key}')`;
  const rowText = (key) => readWhenPresent(evaluate, rowOf(key), 'innerText', `the ${key} row`);
  const typeInto = (key, value) => fillWhenPresent(evaluate, fieldOf(key), value, `the ${key} field`);
  const buttonIn = (scope, label) =>
    `[...((${scope})?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
  const saveDisabled = () => readWhenPresent(evaluate, buttonIn(card, 'Save'), 'disabled', 'the Save button');
  const openEverySection = () =>
    evaluate(`[...document.querySelectorAll('#stack-settings h4 button')]
    .filter(button => button.getAttribute('aria-expanded') === 'false')
    .forEach(button => button.click())`);

  await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/#/deployments/${LADDER}` });
  await waitFor(
    () => evaluate(PAGE_TEXT),
    (text) => text.includes('Stack settings'),
    'the settings card',
  );
  await waitFor(cardText, (text) => text.includes('Engine settings'), 'the engine settings fold');
  await openEverySection();

  await t.test('each rung has a width, a height and a bitrate among the engine settings, grouped by rung', async () => {
    const order = await evaluate(
      `[...document.querySelectorAll('#stack-settings li[data-setting^="ABR_RUNG_"]')].map(row => row.dataset.setting)`,
    );
    assert.deepEqual(
      order,
      ['360P', '480P', '720P', '1080P'].flatMap((rung) =>
        ['WIDTH', 'HEIGHT', 'KBPS'].map((dimension) => `ABR_RUNG_${rung}_${dimension}`),
      ),
    );
    const width = await rowText('ABR_RUNG_1080P_WIDTH');
    assert.match(width, /^1080p width\s+ABR_RUNG_1080P_WIDTH/);
    assert.match(width, /A whole number of pixels from 128 to 3840\./);
    assert.match(width, /Default: 1920 pixels, the manager's own/);
    assert.match(await rowText('ABR_RUNG_360P_KBPS'), /Default: 700 kbps, the manager's own/);
    assert.equal(await evaluate(`${fieldOf('ABR_RUNG_1080P_HEIGHT')}.value`), '1080');
  });

  await t.test('ABR_LADDER shows the value the deployment gets and points at the rung settings', async () => {
    const row = await rowText('ABR_LADDER');
    assert.match(row, new RegExp(SHIPPED_ABR_LADDER));
    assert.match(row, /Put together from the rung settings under Engine settings/);
    assert.doesNotMatch(row, /cannot be set here/);
    assert.equal(await evaluate(`${rowOf('ABR_LADDER')}.querySelectorAll('input, select, textarea').length`), 0);
  });

  await t.test('an odd width is refused under its field', async () => {
    await typeInto('ABR_RUNG_720P_WIDTH', '1279');
    await waitFor(
      () => rowText('ABR_RUNG_720P_WIDTH'),
      (text) =>
        text.includes('720p width must be an even number, because the H.264 encoder refuses odd picture sizes.'),
      'the refusal under the width',
    );
    await waitFor(saveDisabled, (off) => off === true, 'a Save that stops at the odd width');
    await typeInto('ABR_RUNG_720P_WIDTH', '1280');
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the footer back at rest');
  });

  await t.test('a rung no taller than the one below it is named above Save, which stays off', async () => {
    await typeInto('ABR_RUNG_720P_HEIGHT', '480');
    await waitFor(
      cardText,
      (text) => text.includes('The 720p rung has to be taller than the 480p rung below it.'),
      'the order refused above Save',
    );
    assert.equal(await saveDisabled(), true);
    assert.equal(writes.length, 0, 'nothing went to the manager');
    await typeInto('ABR_RUNG_720P_HEIGHT', '720');
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the footer back at rest');
  });

  await t.test('a save sends the changed rung keys alone, which recreate the engine and the uploader', async () => {
    await typeInto('ABR_RUNG_1080P_WIDTH', '2560');
    await typeInto('ABR_RUNG_1080P_HEIGHT', '1440');
    await waitFor(
      () => rowText('ABR_RUNG_1080P_WIDTH'),
      (text) => text.includes('unsaved') && text.includes('recreates srs and stream-uploader'),
      'the marker on the changed width',
    );
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(
      () => writes.length,
      (count) => count === 1,
      'the save',
    );
    assert.deepEqual(writes[0], {
      expectedInstanceId: ABR_LADDER_INSTANCE,
      expectedRevision: 3,
      entries: [
        { key: 'ABR_RUNG_1080P_WIDTH', value: '2560' },
        { key: 'ABR_RUNG_1080P_HEIGHT', value: '1440' },
      ],
    });
  });
});
