/**
 * The archive batches card on the Manager settings page, and the archive chip on the node's own page, in a real
 * Chrome.
 *
 * With the catalogue node designated, the card lists the archive batch the mock seeds, an expired one, with Remove
 * offered. It refuses the catalogue's own batch with the manager's sentence before any save, adopts one of the node's
 * other immutable batches with a label, and holds Remove on that live batch with the sentence why. It removes the
 * expired batch after a confirm. On the node's page the stamps table marks the archive batch. The catalogue is not
 * designated onto an archive batch.
 *
 * A real headless Chrome over a real Vite, proxying to the dev mock manager, which answers the archive routes with
 * the manager's own rules. Runs with the other suites under `pnpm test:browser`, or on its own:
 * `node --import tsx --conditions=development --test test/archive-batches-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  ARCHIVE_REMOVE_LIVE_REFUSAL,
  archiveIsCatalogueBatchRefusal,
  catalogueIsArchiveBatchRefusal,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
} from '@streaming-infra-manager/common';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  pointToClick,
  waitFor,
} from './support/chrome.mjs';
import { freePort, startMockManager } from './support/mock-manager-process.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A first visit can wait on Vite optimizing its dependencies, which a busy machine stretches. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const frontend = fileURLToPath(new URL('../', import.meta.url));

const CARD = `[...document.querySelectorAll('.MuiPaper-root')].find(card => card.querySelector('h3')?.textContent === 'Archive batches')`;
const CARD_TEXT = `(${CARD}?.innerText ?? '')`;
const cardButton = (label) =>
  `[...(${CARD}?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
const rowOf = (batchId) => `${CARD}?.querySelector('[data-archive-batch="${batchId}"]')`;
const rowButton = (batchId, label) =>
  `[...(${rowOf(batchId)}?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;

test('the archive batches card adopts a batch, refuses what the manager refuses, and removes an expired one', async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('archive-batches'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { call, evaluate } = await launchChrome(t, origin);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const card = () => evaluate(CARD_TEXT);
  const fill = (name, value) =>
    fillWhenPresent(evaluate, `document.querySelector('input[name=${name}]')`, value, `the ${name} field`);
  const press = async (finder, description) => {
    const point = await pointToClick(evaluate, finder, description, COLD_OPTIMIZE_BUDGET_MS);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  const option = (text) =>
    `[...document.querySelectorAll('[role=option]')].find(item => item.textContent.includes(${JSON.stringify(text)}))`;
  const choose = async (text, description) => {
    await press(`${CARD}?.querySelector('[role=combobox]')`, `the picker for ${description}`);
    await waitFor(() => evaluate(`Boolean(${option(text)})`), Boolean, `the option for ${description}`);
    // The menu grows in; a point taken mid-transition lands beside the option.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await press(option(text), description);
    await waitFor(
      () => evaluate(`!document.querySelector('[role=listbox]')`),
      Boolean,
      `the menu closed on ${description}`,
    );
  };
  const api = (method, path, payload) =>
    evaluate(`fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { '${REQUESTED_WITH_HEADER}': '${REQUESTED_WITH_VALUE}', 'content-type': 'application/json' },
      ${payload === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(payload))},`}
    }).then(async response => ({ status: response.status, body: await response.json() }))`);
  const normalizedId = (id) => id.replace(/^0x/, '').toLowerCase();

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fill('username', DEV_USERNAME);
  await fill('password', DEV_PASSWORD);
  await clickWhenEnabled(evaluate, buttonWithText('Sign in'), 'an enabled Sign in button');
  await waitFor(body, (text) => text.includes('Versions'), 'the signed-in console', COLD_OPTIMIZE_BUDGET_MS);

  const stamps = (await api('GET', '/profiles/catalogue-node/stamp/stamps')).body.stamps;
  const catalogueBatch = normalizedId(stamps.find((stamp) => stamp.immutableFlag).batchID);
  const spare = normalizedId(stamps.find((stamp) => stamp.label === 'spare-archive').batchID);
  const designated = await api('PUT', '/manager-settings/catalogue-node', {
    expectedRevision: 0,
    profileName: 'catalogue-node',
    batchId: catalogueBatch,
  });
  assert.equal(designated.status, 200, JSON.stringify(designated.body));
  const seeded = (await api('GET', '/manager-settings/archive-batches')).body.batches[0];
  assert.equal(seeded.label, 'Last season', 'the mock seeds one expired archive batch');

  await call('Page.navigate', { url: `${origin}/#/manager-settings` });
  await waitFor(card, (text) => text.includes('Last season on catalogue-node'), 'the card', COLD_OPTIMIZE_BUDGET_MS);

  await t.test('the expired archive batch is listed, not writable, with Remove offered', async () => {
    const shown = await card();
    assert.match(shown, /Last season on catalogue-node/);
    assert.match(shown, /expired · depth 22/);
    assert.match(shown, /Not writable/);
    assert.equal(await evaluate(`${rowButton(seeded.batchId, 'Remove')}?.disabled`), false);
  });

  await t.test('the catalogue’s own batch is refused with the manager’s sentence, before any save', async () => {
    await choose(catalogueBatch.slice(0, 8), 'the catalogue’s batch');
    await waitFor(card, (text) => text.includes(archiveIsCatalogueBatchRefusal(catalogueBatch)), 'the refusal');
    assert.equal(await evaluate(`${cardButton('Adopt')}?.disabled`), true, 'Adopt is held while the batch is refused');
  });

  await t.test('another immutable batch is adopted with its label, writable, and its Remove held', async () => {
    await choose('spare-archive', 'the spare batch');
    await fillWhenPresent(evaluate, `document.getElementById('archive-batch-label')`, 'Spring archive', 'the label');
    await clickWhenEnabled(evaluate, cardButton('Adopt'), 'an enabled Adopt');
    const shown = await waitFor(card, (text) => text.includes('Spring archive on catalogue-node'), 'the adopted batch');
    assert.match(shown, /Writable/);
    assert.equal(await evaluate(`${rowButton(spare, 'Remove')}?.disabled`), true);
    assert.ok((await evaluate(`${rowOf(spare)}?.innerText ?? ''`)).includes(ARCHIVE_REMOVE_LIVE_REFUSAL));
  });

  await t.test('the catalogue is not designated onto an archive batch', async () => {
    const revision = (await api('GET', '/manager-settings/catalogue-node')).body.revision;
    const refused = await api('PUT', '/manager-settings/catalogue-node', {
      expectedRevision: revision,
      profileName: 'catalogue-node',
      batchId: spare,
      move: true,
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body.errors, [catalogueIsArchiveBatchRefusal(spare)]);
  });

  await t.test('the node’s page marks the archive batch in its stamps table', async () => {
    await call('Page.navigate', { url: `${origin}/#/deployments/catalogue-node` });
    await waitFor(
      () => evaluate(`document.querySelectorAll('[data-archive-batch-chip]').length`),
      (count) => count === 2,
      'the archive chips of the two archive batches',
      COLD_OPTIMIZE_BUDGET_MS,
    );
  });

  await t.test('the expired archive batch is removed after a confirm', async () => {
    await call('Page.navigate', { url: `${origin}/#/manager-settings` });
    await waitFor(card, (text) => text.includes('Last season on catalogue-node'), 'the card', COLD_OPTIMIZE_BUDGET_MS);
    await clickWhenEnabled(evaluate, rowButton(seeded.batchId, 'Remove'), 'the Remove of the expired batch');
    const dialog = () => evaluate(`document.querySelector('[role=dialog]')?.innerText ?? ''`);
    await waitFor(dialog, (text) => text.includes('Remove the archive batch?'), 'the confirm');
    await clickWhenEnabled(
      evaluate,
      `[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === 'Remove')`,
      'the confirm button',
    );
    const shown = await waitFor(card, (text) => !text.includes('Last season'), 'the removal');
    assert.match(shown, /Spring archive on catalogue-node/);
  });
});
