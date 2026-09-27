/**
 * That the config file editor's text follows the colour scheme the operator chose.
 *
 * MUI 7 stopped swapping the theme object when the scheme changes, so a colour
 * read from `theme.palette` stays the light scheme's in the dark one. The editor
 * read its text colour that way and, on MUI 9 in the dark scheme, painted the
 * light scheme's near-black text on the dark dialog. The page body takes its
 * colour from the same palette entry through CSS variables, so the two must agree
 * in both schemes.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, PAGE_TEXT, pointToClick, reloadDocument, waitFor } from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const SCHEMES = ['light', 'dark'];

const profile = {
  name: 'scheme-stage', kind: 'streamer', status: 'RUNNING', port_slot: 1, host: 'localhost',
  notes: null, last_error: null, last_error_at: null,
  created_at: '2026-09-27T06:51:00Z', updated_at: '2026-09-27T06:58:00Z',
  engine_settings: {}, has_engine_config: false, engine_config_error: null, engine_config_state: null,
  stamp_id: null, public_key: '1'.repeat(40), pendingStamp: false,
  containers: [{ service: 'srs', ports: {} }],
};

test('the config file editor writes its text in the chosen scheme', async (t) => {
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('code-text-area-scheme'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'offline-engine-config-fixture',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
          if (path === '/auth/session') return json({ username: 'scheme-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
          if (path === '/profiles') return json({ profiles: [profile] });
          if (path === '/groups') return json({ groups: [] });
          if (path === '/versions') return json([]);
          if (path === '/versions/attempts') return json({ attempts: [] });
          if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
          if (path === '/events' || path?.startsWith('/metrics')) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': offline fixture\n\n');
            return;
          }
          if (path === '/profiles/scheme-stage/engine-config') {
            return json({ engine: 'srs', supported: true, unsupportedReason: null, config: null,
              template: 'listen        RTMP_PORT_PLACEHOLDER;', placeholders: ['RTMP_PORT_PLACEHOLDER'],
              state: null, error: null, references: [] });
          }
          if (path?.startsWith('/profiles/')) return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
          return next();
        });
      },
    }],
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  const dialog = `document.querySelector('[role="dialog"]')`;

  const seen = {};
  for (const scheme of SCHEMES) {
    await call('Page.navigate', { url: `${origin}/#/deployments/scheme-stage` });
    await waitFor(() => evaluate(PAGE_TEXT), text => text.includes('Config file'), 'the deployment page');
    await evaluate(`localStorage.setItem('mui-mode', ${JSON.stringify(scheme)})`);
    await reloadDocument(browser);
    await waitFor(() => evaluate(PAGE_TEXT), text => text.includes('Config file'), `the deployment page in the ${scheme} scheme`);
    const point = await pointToClick(evaluate, `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Config file')`, 'an enabled Config file button');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await waitFor(() => evaluate(`!!${dialog}?.querySelector('textarea')`), Boolean, `the config file editor in the ${scheme} scheme`);
    seen[scheme] = await evaluate(`({
      editor: getComputedStyle(${dialog}.querySelector('textarea')).color,
      body: getComputedStyle(document.body).color,
    })`);
    assert.equal(seen[scheme].editor, seen[scheme].body, `the editor's text in the ${scheme} scheme is ${seen[scheme].editor}, the page's is ${seen[scheme].body}`);
  }
  assert.notEqual(seen.light.body, seen.dark.body, 'the two schemes gave the page the same text colour, so the scheme never changed');
});
