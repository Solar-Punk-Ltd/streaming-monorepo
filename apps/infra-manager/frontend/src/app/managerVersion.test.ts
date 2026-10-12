/**
 * The sidebar's line for the build the manager runs: what it reads from the manager, and what it shows under
 * "Streaming Infra", after the name of the instance when it has one, with the full commit as its title.
 *
 * Unit test, no DOM: the line is rendered to markup. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { VersionInfo } from '@streaming-infra-manager/common';

import { ManagerVersionLine } from './ManagerVersionLine';
import { fetchManagerVersion } from './managerVersion';
import { Sidebar } from './Sidebar';
import { SessionProvider, type SessionStore } from './useSession';

const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';
const SHORT = '635b4e175';

/** The whole sidebar as markup, as a signed-in page renders it, for a manager that answered `managerVersion`. */
function sidebarMarkup(managerVersion: VersionInfo | null, instanceName: string | null = 'swarm-dev'): string {
  const session: SessionStore = {
    state: { status: 'signedIn', id: 1, username: 'operator', isAdmin: true, expiresAt: '2026-10-08T00:00:00.000Z' },
    signIn: async () => {
      throw new Error('not in this test');
    },
    signOut: async () => undefined,
  };
  return renderToStaticMarkup(
    createElement(
      SessionProvider,
      { value: session },
      createElement(Sidebar, {
        route: { page: 'overview' },
        deploymentCount: null,
        instanceName,
        managerVersion,
      }),
    ),
  );
}

/** The one element the line renders, by its text and its title, or null when it renders nothing at all. */
function sidebarLine(
  version: VersionInfo | null,
  instanceName: string | null = null,
): { text: string; title: string | null } | null {
  const markup = renderToStaticMarkup(createElement(ManagerVersionLine, { version, instanceName }));
  if (markup === '') return null;
  const element = /<span([^>]*)>([^<]*)<\/span>/.exec(markup);
  assert.ok(element, `the line is one element of text: ${markup}`);
  const title = / title="([^"]*)"/.exec(element[1] ?? '');
  return { text: element[2] ?? '', title: title?.[1] ?? null };
}

describe('the line under "Streaming Infra"', () => {
  it('names a tagged build by its tag and its short commit, with the full commit as its title', () => {
    assert.deepEqual(sidebarLine({ label: 'QA-build-2026-10-07', commit: COMMIT }), {
      text: `QA-build-2026-10-07 (${SHORT})`,
      title: COMMIT,
    });
  });

  it('names a build past a tag by the tag, the distance and the short commit', () => {
    assert.deepEqual(sidebarLine({ label: 'QA-build-2026-10-07+3', commit: COMMIT }), {
      text: `QA-build-2026-10-07+3 (${SHORT})`,
      title: COMMIT,
    });
  });

  it('names an untagged build by its short commit once, the label it already is', () => {
    assert.deepEqual(sidebarLine({ label: SHORT, commit: COMMIT }), { text: SHORT, title: COMMIT });
  });

  it('keeps -dirty, so a build of uncommitted changes says it is one', () => {
    assert.deepEqual(sidebarLine({ label: `${SHORT}-dirty`, commit: COMMIT }), {
      text: `${SHORT}-dirty`,
      title: COMMIT,
    });
    assert.deepEqual(sidebarLine({ label: 'QA-build-2026-10-07-dirty', commit: COMMIT }), {
      text: `QA-build-2026-10-07-dirty (${SHORT})`,
      title: COMMIT,
    });
  });

  it('says development build when no version is set, with no title when no commit is either', () => {
    assert.deepEqual(sidebarLine({ label: null, commit: null }), { text: 'development build', title: null });
  });

  it('shows nothing until the manager has said which build it runs', () => {
    assert.equal(sidebarLine(null), null);
  });

  it('starts with the name of the instance when the manager has one', () => {
    assert.deepEqual(sidebarLine({ label: 'v1.1.1', commit: COMMIT }, 'swarm-dev'), {
      text: `swarm-dev · v1.1.1 (${SHORT})`,
      title: COMMIT,
    });
    assert.deepEqual(sidebarLine({ label: null, commit: null }, 'swarm-dev'), {
      text: 'swarm-dev · development build',
      title: null,
    });
    assert.deepEqual(sidebarLine(null, 'swarm-dev'), { text: 'swarm-dev', title: null });
  });

  it('sits in the sidebar under "Streaming Infra", above the pages, and names no host', () => {
    const markup = sidebarMarkup({ label: 'v1.1.1', commit: COMMIT });

    const product = markup.indexOf('Streaming Infra');
    const line = markup.indexOf(`title="${COMMIT}">swarm-dev · v1.1.1 (${SHORT})</span>`);
    assert.notEqual(product, -1, markup);
    assert.ok(line > product, 'the instance and its build are named under the product');
    assert.ok(line < markup.indexOf('Overview'), 'and above the first page');
    assert.doesNotMatch(markup, /manager · /, 'the ingest host is shown where a deployment publishes, not here');
    assert.equal(
      sidebarMarkup(null, null).includes('development build'),
      false,
      'no answer is not a development build',
    );
  });

  it('shows the build alone under "Streaming Infra" when the manager has no instance name', () => {
    const markup = sidebarMarkup({ label: 'v1.1.1', commit: COMMIT }, null);

    assert.match(markup, new RegExp(`title="${COMMIT}">v1\\.1\\.1 \\(${SHORT}\\)</span>`));
    assert.doesNotMatch(markup, / · /);
  });
});

describe('fetchManagerVersion', () => {
  const globals = globalThis as { fetch: typeof fetch };
  const browserFetch = globals.fetch;

  afterEach(() => {
    globals.fetch = browserFetch;
  });

  /** A fetch that answers `body` as JSON, and the requests it was asked. */
  function answering(body: unknown): { path: string; method: string }[] {
    const asked: { path: string; method: string }[] = [];
    globals.fetch = (async (path: unknown, init?: { method?: string }) => {
      asked.push({ path: String(path), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return asked;
  }

  it('reads GET /version and answers the label and the commit', async () => {
    const asked = answering({ label: 'QA-build-2026-10-07', commit: COMMIT });

    assert.deepEqual(await fetchManagerVersion(), { label: 'QA-build-2026-10-07', commit: COMMIT });
    assert.deepEqual(asked, [{ path: '/version', method: 'GET' }]);
  });

  it('answers null for a field that is missing or of another shape', async () => {
    answering({ label: 'QA build', commit: SHORT });
    assert.deepEqual(await fetchManagerVersion(), { label: null, commit: null });

    answering({});
    assert.deepEqual(await fetchManagerVersion(), { label: null, commit: null });

    answering(null);
    assert.deepEqual(await fetchManagerVersion(), { label: null, commit: null });
  });
});
