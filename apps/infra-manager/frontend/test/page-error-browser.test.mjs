/**
 * A page that throws while it renders is contained to that page.
 *
 * A real headless Chrome over a real Vite, proxying to the dev mock manager.
 * The users list is answered in a shape the Access page cannot render, as an
 * API change or a mismatched manager could answer it, so the page throws. The
 * console must say so where the page was and keep its navigation, rather than
 * unmount the whole tree and leave a blank window that only a reload clears.
 * Runs with the other suites here under `pnpm test:browser`, or on its own:
 * `node --import tsx --test frontend/test/page-error-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  waitFor,
} from './support/chrome.mjs';
import { freePort, startMockManager } from './support/mock-manager-process.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A first visit can wait on Vite optimizing its dependencies, which a busy machine stretches. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** Answers the users list with an object where the page expects a list, before the app's own code loads. */
const USERS_IN_ANOTHER_SHAPE = `(() => {
  const original = window.fetch;
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.pathname === '/auth/users') {
      return Promise.resolve(
        new Response(JSON.stringify({ users: 'not a list' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return original(input, init);
  };
})();`;

test('a page that throws while rendering shows a message in its place and the navigation still works', async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('page-error'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { call, evaluate } = await launchChrome(t, origin);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: USERS_IN_ANOTHER_SHAPE });

  const body = () => evaluate(PAGE_TEXT);
  const fill = (name, value) =>
    fillWhenPresent(evaluate, `document.querySelector('input[name=${name}]')`, value, `the ${name} field`);
  const navItem = (label) =>
    `[...document.querySelectorAll('[role=button]')].find(node => node.textContent.trim() === ${JSON.stringify(label)})`;

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fill('username', DEV_USERNAME);
  await fill('password', DEV_PASSWORD);
  await clickWhenEnabled(evaluate, buttonWithText('Sign in'), 'an enabled Sign in button');
  await waitFor(body, (text) => text.includes('Versions'), 'the signed-in console', COLD_OPTIMIZE_BUDGET_MS);

  await call('Page.navigate', { url: `${origin}/#/access` });
  const shown = await waitFor(
    body,
    (text) => text.includes('This page could not be shown'),
    'the message in place of the page that threw',
    COLD_OPTIMIZE_BUDGET_MS,
  );
  assert.match(shown, /Access/, 'the page title and the navigation around it stay');

  await clickWhenEnabled(evaluate, navItem('Versions'), 'the Versions item in the navigation');
  const moved = await waitFor(
    body,
    (text) => !text.includes('This page could not be shown') && text.includes('Add version'),
    'the Versions page after leaving the page that threw',
    COLD_OPTIMIZE_BUDGET_MS,
  );
  assert.doesNotMatch(moved, /This page could not be shown/);
});
