/**
 * What closes the New deployment dialog, in a real Chrome with a real mouse.
 *
 * Until 2026-09-30 a click beside the dialog closed it, and since the wizard
 * is mounted only while it is open, that one stray click threw away every
 * choice made in it. This walks what closes it now and what does not: a click
 * on the backdrop leaves the dialog and its draft where they were, the close
 * button in the title and Escape close it, and Deploy closes it at the end of
 * the flow.
 *
 * A real headless Chrome over a real Vite, proxying to the real dev mock
 * manager. Runs with the other suites under `pnpm test:browser`, or on its
 * own: `node --import tsx --conditions=development --test test/wizard-close-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  pointToClick,
  readWhenPresent,
  waitFor,
} from './support/chrome.mjs';
import { freePort, startMockManager } from './support/mock-manager-process.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A cold Vite cache can hold a wizard step behind a dependency re-optimization, and this is only spent while waiting. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

/**
 * How long a dialog that was going to close is given to be gone.
 *
 * A close unmounts the wizard in the render the click causes, so two frames
 * would do. The rest is margin for a slow runner, and it is only spent where
 * the test proves the dialog stayed.
 */
const CLOSE_MARGIN_MS = 500;

const frontend = fileURLToPath(new URL('../', import.meta.url));

const NAME = 'kept-draft';

test('the New deployment dialog closes only when it is told to', { timeout: 300_000 }, async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('wizard-close'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  // A laptop's width, so the backdrop shows on both sides of the dialog.
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const found = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const dialogOpen = () => evaluate(`Boolean(${found('[role=dialog]')})`);
  const nameField = found('input[placeholder="main-stage"]');
  // A pressed and released mouse rather than click(), since the backdrop
  // tells a click on itself apart by where the press began.
  const mouseAt = async (point) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await settled();
  };
  const press = async (finder, description) =>
    mouseAt(await pointToClick(evaluate, finder, description, COLD_OPTIMIZE_BUDGET_MS));
  const pressKey = async (key, code, keyCode) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    await settled();
  };
  const closedBy = (how) => waitFor(dialogOpen, (open) => !open, `the dialog closed by ${how}`);
  // The point half way between the window's left edge and the dialog, on the
  // modal but outside the dialog's own paper, which is what clicking outside
  // the dialog means.
  const besideTheDialog = () =>
    waitFor(
      () =>
        evaluate(`(() => {
    const paper = document.querySelector('.MuiDialog-paper');
    if (!paper) return null;
    const box = paper.getBoundingClientRect();
    const point = { x: Math.round(box.left / 2), y: Math.round(box.top + box.height / 2) };
    const under = document.elementFromPoint(point.x, point.y);
    return under?.closest('.MuiDialog-root') && !paper.contains(under) ? point : null;
  })()`),
      Boolean,
      'a point on the backdrop beside the dialog',
    );
  // As far as a typed name, which is what a stray close used to throw away.
  const openWithDraft = async () => {
    await press(buttonWithText('New deployment'), 'the New deployment button');
    await press(
      `[...document.querySelectorAll('[role=radio]')].find(node => node.textContent.trim().startsWith('Stream to Swarm'))`,
      'the Stream to Swarm goal',
    );
    await press(buttonWithText('Continue'), 'the Continue button');
    await fillWhenPresent(evaluate, nameField, NAME, 'the name field', COLD_OPTIMIZE_BUDGET_MS);
  };

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fillWhenPresent(evaluate, found('input[name=username]'), DEV_USERNAME, 'the username field');
  await fillWhenPresent(evaluate, found('input[name=password]'), DEV_PASSWORD, 'the password field');
  await clickWhenEnabled(evaluate, buttonWithText('Sign in'), 'the Sign in button', COLD_OPTIMIZE_BUDGET_MS);
  await waitFor(body, (text) => text.includes('New deployment'), 'the app to boot', COLD_OPTIMIZE_BUDGET_MS);

  await t.test('a click on the backdrop leaves the dialog open, with what was typed in it', async () => {
    await openWithDraft();
    await mouseAt(await besideTheDialog());
    await delay(CLOSE_MARGIN_MS);
    assert.equal(await dialogOpen(), true, 'a click beside the dialog closed it');
    assert.equal(await readWhenPresent(evaluate, nameField, 'value', 'the name field'), NAME);
  });

  await t.test('the close button in the title closes it', async () => {
    await press(found('[role=dialog] button[aria-label="close"]'), 'the close button');
    await closedBy('its close button');
  });

  await t.test('Escape closes it, as the keyboard way out', async () => {
    await openWithDraft();
    await pressKey('Escape', 'Escape', 27);
    await closedBy('Escape');
  });

  await t.test('Deploy closes it at the end of the flow, on the new deployment page', async () => {
    await openWithDraft();
    await press(buttonWithText('Continue'), 'the Continue button to the settings');
    await press(buttonWithText('Continue'), 'the Continue button to the review');
    await press(buttonWithText('Deploy'), 'the Deploy button');
    await closedBy('Deploy');
    await waitFor(
      () => evaluate('location.hash'),
      (hash) => hash === `#/deployments/${NAME}`,
      `the ${NAME} page`,
    );
  });

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});
