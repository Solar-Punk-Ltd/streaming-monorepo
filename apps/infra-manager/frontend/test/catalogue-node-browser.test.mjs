/**
 * The catalogue node card on the Manager settings page, and the pinned batch on the node's own page, in a real
 * Chrome.
 *
 * The card starts with nothing designated. It offers the deployments that are nothing but a Bee node, refuses a
 * mutable batch with the manager's sentence before any save, designates an immutable one with its reading and the
 * line saying how the last push went, and clears it. On the node's page the pinned batch is marked, the Storage and
 * funding card says that Buy and Use leave the catalogue on it, and Top up stays offered. Cleared, the card says the
 * catalogue stays pinned to that batch, still refuses a mutable one, and designates the same one again. The node's
 * removal is refused while it is designated and after a clear. Designated, it moves the catalogue to the node's
 * other immutable batch after a confirm, shows the batch moved from with its reading and the steps, refuses a third
 * batch while the move is pending, and releases the previous batch after another confirm.
 *
 * A real headless Chrome over a real Vite, proxying to the dev mock manager, which answers the catalogue routes with
 * the manager's own rules. Runs with the other suites under `pnpm test:browser`, or on its own:
 * `node --import tsx --conditions=development --test test/catalogue-node-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  CATALOGUE_MUTABLE_REFUSAL,
  catalogueReleaseFirstRefusal,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  shortHex,
} from '@streaming-infra-manager/common';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import { catalogueMoveConfirmText, catalogueMoveLabel } from '../src/catalogueNode/catalogueNodeView.ts';
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

const CARD = `[...document.querySelectorAll('.MuiPaper-root')].find(card => card.querySelector('h3')?.textContent === 'Catalogue node')`;
const CARD_TEXT = `(${CARD}?.innerText ?? '')`;
const cardButton = (label) =>
  `[...(${CARD}?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
const combobox = (index) => `(${CARD}?.querySelectorAll('[role=combobox]') ?? [])[${index}]`;

test('the catalogue node card designates an immutable batch, refuses a mutable one, and marks it on the node', async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('catalogue-node'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { call, evaluate } = await launchChrome(t, origin);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const card = () => evaluate(CARD_TEXT);
  const fill = (name, value) =>
    fillWhenPresent(evaluate, `document.querySelector('input[name=${name}]')`, value, `the ${name} field`);
  /** A real pointer, which is what opens a select's menu. */
  const press = async (finder, description) => {
    const point = await pointToClick(evaluate, finder, description, COLD_OPTIMIZE_BUDGET_MS);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  const option = (text) =>
    `[...document.querySelectorAll('[role=option]')].find(item => item.textContent.includes(${JSON.stringify(text)}))`;
  /** Opens a select of the card, waits for its menu to settle, picks the option that reads `text`, and waits it closed. */
  const choose = async (index, text, description) => {
    await press(combobox(index), `the picker for ${description}`);
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
  /** The mock's batches of the catalogue node, read as the page reads them. */
  const batchesOf = (name) =>
    evaluate(`fetch('/profiles/${name}/stamp/stamps', { headers: { '${REQUESTED_WITH_HEADER}': '${REQUESTED_WITH_VALUE}' } })
      .then(response => response.json()).then(answer => answer.stamps)`);

  const removal = () =>
    evaluate(`fetch('/profiles/catalogue-node', {
      method: 'DELETE',
      headers: { '${REQUESTED_WITH_HEADER}': '${REQUESTED_WITH_VALUE}', 'content-type': 'application/json' },
      body: '{}',
    }).then(async response => ({ status: response.status, body: await response.json() }))`);

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fill('username', DEV_USERNAME);
  await fill('password', DEV_PASSWORD);
  await clickWhenEnabled(evaluate, buttonWithText('Sign in'), 'an enabled Sign in button');
  await waitFor(body, (text) => text.includes('Versions'), 'the signed-in console', COLD_OPTIMIZE_BUDGET_MS);

  await call('Page.navigate', { url: `${origin}/#/manager-settings` });
  await waitFor(
    card,
    (text) => text.includes('No catalogue node is designated'),
    'the card with nothing designated',
    COLD_OPTIMIZE_BUDGET_MS,
  );
  assert.match(await card(), /Web2 admin: not sent yet/);

  const stamps = await batchesOf('catalogue-node');
  const [immutable, next] = stamps.filter((stamp) => stamp.immutableFlag);
  const mutable = stamps.find((stamp) => !stamp.immutableFlag);
  assert.ok(
    immutable && next && mutable,
    'the mock seeds the catalogue node with two immutable batches and a mutable one',
  );
  const shortOf = (id) => id.slice(0, 8);

  await t.test('only Bee-only deployments are offered, and a pool rung is refused with its reason', async () => {
    await press(combobox(0), 'the deployment picker');
    const offered = await waitFor(
      () => evaluate(`[...document.querySelectorAll('[role=option]')].map(item => item.textContent)`),
      (items) => items.length > 0,
      'the offered deployments',
    );
    assert.ok(offered.includes('catalogue-node'));
    assert.equal(offered.includes('main-stage'), false, 'a stage is no catalogue node');
    const rung = offered.find((name) => name.startsWith('abr-pool-1-'));
    assert.ok(rung, 'a pool rung is listed, to be refused');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await press(option(rung), 'a pool rung');
    await waitFor(() => evaluate(`!document.querySelector('[role=listbox]')`), Boolean, 'the menu closed');
    await waitFor(card, (text) => text.includes('is a rung of an ABR node pool'), 'the rung’s refusal');
    assert.equal(await evaluate(`${cardButton('Save')}?.disabled`), true);
  });

  await t.test('a mutable batch is refused with the manager’s sentence, before any save', async () => {
    await choose(0, 'catalogue-node', 'the catalogue node');
    await waitFor(card, (text) => text.includes('One of the batches the node holds'), 'the node’s batches');
    await choose(1, shortOf(mutable.batchID), 'the mutable batch');
    await waitFor(card, (text) => text.includes(CATALOGUE_MUTABLE_REFUSAL), 'the mutable refusal');
    assert.equal(await evaluate(`${cardButton('Save')}?.disabled`), true, 'Save is held while the batch is refused');
  });

  await t.test('an immutable batch is designated, with its reading and the last push', async () => {
    await choose(1, shortOf(immutable.batchID), 'the immutable batch');
    await clickWhenEnabled(evaluate, cardButton('Save'), 'an enabled Save');
    const shown = await waitFor(card, (text) => text.includes('Clear the designation'), 'the designation');
    assert.match(shown, /catalogue-node, batch/);
    assert.match(shown, /active · depth 20 · \d+d \d+h left · \d+% full · immutable/);
    assert.match(shown, /Web2 admin: stored \d+ s ago/);
  });

  await t.test('the node’s page marks the pinned batch and says Buy and Use leave the catalogue on it', async () => {
    await call('Page.navigate', { url: `${origin}/#/deployments/catalogue-node` });
    await waitFor(
      () => evaluate(`document.querySelector('[data-catalogue-note]')?.innerText ?? ''`),
      (text) => text.includes('leaves the catalogue on the pinned one'),
      'the pinned batch note',
      COLD_OPTIMIZE_BUDGET_MS,
    );
    assert.equal(await evaluate(`document.querySelectorAll('[data-catalogue-pinned]').length`), 1);
    assert.ok(await evaluate(`Boolean(${buttonWithText('Top up')})`), 'Top up is still offered');
  });

  await t.test('the designated node is not removed while it is designated', async () => {
    const answer = await removal();
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'catalogue_node_designated');
  });

  await t.test('the designation is cleared, and the card says the catalogue stays pinned to its batch', async () => {
    await call('Page.navigate', { url: `${origin}/#/manager-settings` });
    await waitFor(
      card,
      (text) => text.includes('Clear the designation'),
      'the designated card',
      COLD_OPTIMIZE_BUDGET_MS,
    );
    assert.equal(
      await evaluate(`Boolean(${cardButton('Change')})`),
      false,
      'a designation is not changed to another batch',
    );
    await clickWhenEnabled(evaluate, cardButton('Clear the designation'), 'the clear button', COLD_OPTIMIZE_BUDGET_MS);
    const cleared = await waitFor(card, (text) => text.includes('No catalogue node is designated'), 'the clear');
    assert.match(cleared, /Web2 admin: cleared \d+ s ago/);
    assert.match(cleared, /The catalogue stays pinned to batch .* on catalogue-node/);
  });

  await t.test('the cleared node is still not removed', async () => {
    const answer = await removal();
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'catalogue_node_designated');
  });

  await t.test('a mutable batch is still refused, and the same one is designated again', async () => {
    await waitFor(card, (text) => text.includes('One of the batches the node holds'), 'the pinned node’s batches');
    await choose(1, shortOf(mutable.batchID), 'another batch');
    await waitFor(card, (text) => text.includes(CATALOGUE_MUTABLE_REFUSAL), 'the mutable refusal');
    const moveLabel = catalogueMoveLabel(mutable.batchID.replace(/^0x/, '').toLowerCase());
    assert.equal(await evaluate(`${cardButton(moveLabel)}?.disabled`), true, 'the move it would be is held');
    await choose(1, shortOf(immutable.batchID), 'the pinned batch');
    await clickWhenEnabled(evaluate, cardButton('Designate again'), 'an enabled Designate again');
    await waitFor(card, (text) => text.includes('Clear the designation'), 'the designation again');
  });

  const dialogButton = (label) =>
    `[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
  const dialogText = () => evaluate(`document.querySelector('[role=dialog]')?.innerText ?? ''`);
  const normalizedId = (id) => id.replace(/^0x/, '').toLowerCase();

  await t.test('another immutable batch moves the catalogue after a confirm, with the steps', async () => {
    await clickWhenEnabled(evaluate, cardButton('Move to another batch'), 'the move button');
    await waitFor(card, (text) => text.includes('One of the batches the node holds'), 'the node’s batches');
    await choose(1, shortOf(next.batchID), 'the batch to move to');
    const label = catalogueMoveLabel(normalizedId(next.batchID));
    await clickWhenEnabled(evaluate, cardButton(label), `an enabled ${label}`);
    const confirmText = await waitFor(dialogText, (text) => text.includes('Move the catalogue?'), 'the move confirm');
    assert.ok(
      confirmText.includes(catalogueMoveConfirmText(normalizedId(immutable.batchID), normalizedId(next.batchID))),
    );
    await clickWhenEnabled(evaluate, dialogButton('Move the catalogue'), 'the confirm');
    const moving = await waitFor(card, (text) => text.includes('Moving from batch'), 'the pending move');
    assert.ok(moving.includes(`Moving from batch ${shortHex(normalizedId(immutable.batchID))} on catalogue-node`));
    assert.match(moving, /Stages page, start “Move the catalogue to batch/);
    assert.match(moving, /CATALOGUE_MOVE_ENABLED/);
    assert.match(moving, /Wait until it says the move is done\./);
    assert.match(moving, /active · depth 20 · \d+d \d+h left/, 'the batch moved from is still read');
    assert.ok(moving.includes(`catalogue-node, batch ${shortHex(normalizedId(next.batchID))}`));
    assert.ok(await evaluate(`Boolean(${cardButton('Release the previous batch')})`));
  });

  await t.test('a third batch is refused while the move is pending', async () => {
    await clickWhenEnabled(evaluate, cardButton('Move to another batch'), 'the move button');
    await waitFor(card, (text) => text.includes('One of the batches the node holds'), 'the node’s batches');
    await choose(1, shortOf(mutable.batchID), 'a third batch');
    await waitFor(
      card,
      (text) => text.includes(catalogueReleaseFirstRefusal(normalizedId(immutable.batchID))),
      'the release-first refusal',
    );
    await clickWhenEnabled(evaluate, cardButton('Cancel'), 'the cancel of the move');
  });

  await t.test('the previous batch is released after a confirm, and the move ends', async () => {
    await clickWhenEnabled(evaluate, cardButton('Release the previous batch'), 'the release button');
    const confirmText = await waitFor(
      dialogText,
      (text) => text.includes('Release the previous batch?'),
      'the release confirm',
    );
    assert.match(confirmText, /catalogue-node can then be removed, and the batch may lapse/);
    await clickWhenEnabled(evaluate, dialogButton('Release'), 'the confirm');
    const released = await waitFor(card, (text) => text.includes('Previous batch released'), 'the release');
    assert.equal(released.includes('Moving from batch'), false);
    assert.equal(await evaluate(`Boolean(${cardButton('Release the previous batch')})`), false);
  });
});
