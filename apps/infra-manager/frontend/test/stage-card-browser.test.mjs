/**
 * The stage card on a deployment page: the public ingest address, edited in
 * place with the sentence that says what it is, and the line saying how the
 * manager's last push of the stage record into the web2 admin went.
 *
 * A real headless Chrome over a real Vite, proxying to the dev mock manager.
 * Runs with the other suites here under `pnpm test:browser`, or on its own:
 * `node --import tsx --test frontend/test/stage-card-browser.test.mjs`.
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

/** The card, found by its title. */
const CARD = `[...document.querySelectorAll('.MuiPaper-root')].find(card => card.textContent.startsWith('Web2 admin stage'))`;
const CARD_TEXT = `(${CARD}?.innerText ?? '')`;
const cardButton = (label) =>
  `[...(${CARD}?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;

test('the stage card shows the ingest address, saves one, refuses a port and says how the last push went', async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('stage-card'),
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

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fill('username', DEV_USERNAME);
  await fill('password', DEV_PASSWORD);
  await clickWhenEnabled(evaluate, buttonWithText('Sign in'), 'an enabled Sign in button');
  await waitFor(body, (text) => text.includes('Versions'), 'the signed-in console', COLD_OPTIMIZE_BUDGET_MS);

  await call('Page.navigate', { url: `${origin}/#/deployments/main-stage` });
  const shown = await waitFor(
    card,
    (text) => /Web2 admin registration: registered \d+ s ago/.test(text),
    'the stage card with its registration line',
    COLD_OPTIMIZE_BUDGET_MS,
  );
  assert.match(shown, /Public ingest address/);
  assert.match(shown, /resolved/);

  await clickWhenEnabled(evaluate, cardButton('Edit'), 'the card’s Edit button');
  await waitFor(
    card,
    (text) => text.includes('The address encoders dial. The address ssh uses can be a private one.'),
    'the help sentence',
  );

  await fillWhenPresent(
    evaluate,
    `document.getElementById('stage-ingest-host')`,
    'ingest.example.org:9000',
    'the address field',
  );
  await waitFor(card, (text) => /no scheme, port or path/.test(text), 'the refusal of an address with a port');
  assert.equal(await evaluate(`${cardButton('Save')}?.disabled`), true, 'Save is held while the address is refused');

  await fillWhenPresent(
    evaluate,
    `document.getElementById('stage-ingest-host')`,
    'ingest.example.org',
    'the address field',
  );
  await clickWhenEnabled(evaluate, cardButton('Save'), 'an enabled Save');
  const saved = await waitFor(card, (text) => text.includes('Set for this deployment.'), 'the saved address');
  assert.match(saved, /ingest\.example\.org/);

  await clickWhenEnabled(evaluate, cardButton('Use the resolved host'), 'the reset button');
  await waitFor(
    card,
    (text) => !text.includes('ingest.example.org') && text.includes('resolved'),
    'the resolved host again',
  );

  // Rotate the uploader's admin token: asked first, then the sentence that says a redeploy gives the new one.
  assert.match(await card(), /The next deploy gives the uploader a new token of its own/);
  await clickWhenEnabled(evaluate, cardButton("Rotate the uploader's admin token"), 'the rotate action');
  const dialog = `document.querySelector('[role=dialog]')`;
  await waitFor(
    () => evaluate(`${dialog}?.innerText ?? ''`),
    (text) => text.includes('stops taking it once the manager next pushes this stage'),
    'the rotate confirmation',
  );
  await clickWhenEnabled(
    evaluate,
    `[...(${dialog}?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Rotate')`,
    'the confirmation’s Rotate button',
  );
  await waitFor(
    body,
    (text) => text.includes("The uploader's admin token is cleared. Redeploy"),
    'the rotated sentence',
  );

  await call('Page.navigate', { url: `${origin}/#/deployments/viewer-eu` });
  await waitFor(body, (text) => text.includes('viewer-eu'), 'a viewer’s page', COLD_OPTIMIZE_BUDGET_MS);
  assert.equal(await evaluate(`Boolean(${CARD})`), false, 'a viewer is no stage');
});
