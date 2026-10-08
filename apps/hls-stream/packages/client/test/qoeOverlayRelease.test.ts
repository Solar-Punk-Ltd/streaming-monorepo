import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, it, vi } from 'vitest';

import { QoeOverlay } from '../src/components/SwarmHlsPlayer/overlays/qoe/QoeOverlay';
import { initialMetrics } from '../src/components/SwarmHlsPlayer/overlays/qoe/useHlsQoeMetrics';
import { type PlayerRelease, playerRelease, playerReleaseText } from '../src/utils/playerRelease';

/** A whole commit whose first nine characters are the ones the overlay shows. */
const COMMIT = '1702aff1b3f35866819f9b6c02307567165f3d05';
const LABEL = 'QA-build-2026-10-07';

/** The overlay as it first renders, panel open, which is how `?qoe=1` opens it. */
function render(release?: PlayerRelease | null): string {
  const metrics = initialMetrics();
  return renderToStaticMarkup(createElement(QoeOverlay, release === undefined ? { metrics } : { metrics, release }));
}

/** The release line's label and value, or null when the overlay has none. */
function releaseLine(html: string): { label: string; value: string; title: string | null } | null {
  const line =
    /<div class="qoe-overlay__row qoe-overlay__release"><span class="qoe-overlay__label">([^<]*)<\/span><span class="qoe-overlay__value"(?: title="([^"]*)")?>([^<]*)<\/span><\/div>/.exec(
      html,
    );
  return line ? { label: line[1]!, value: line[3]!, title: line[2] ?? null } : null;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * The player names the release it was built as in its QoE overlay, which `?qoe=1` on a watch URL
 * opens, and nowhere else. The deploy builds the label and the commit of the stack build in, and the
 * overlay shows them by the rule every console of this project shows a release by.
 */
describe('the release in the QoE overlay', () => {
  it('shows the label with the first nine characters of the commit beside it', () => {
    const line = releaseLine(render({ label: LABEL, commit: COMMIT }));

    assert.deepEqual(line, { label: 'Player', value: 'QA-build-2026-10-07 (1702aff1b)', title: COMMIT });
  });

  it('shows the label alone when it already starts with those nine, as an untagged build is named', () => {
    assert.equal(releaseLine(render({ label: '1702aff1b-dirty', commit: COMMIT }))?.value, '1702aff1b-dirty');
    assert.equal(releaseLine(render({ label: 'QA-build+3', commit: null }))?.value, 'QA-build+3');
  });

  it('shows no release line at all when there is no release', () => {
    const html = render(null);

    assert.equal(releaseLine(html), null);
    assert.doesNotMatch(html, /qoe-overlay__release/);
    assert.doesNotMatch(html, /Player/);
    // The control: the panel itself is there, so the line is missing and not the panel.
    assert.match(html, /QoE Metrics/);
  });

  // The test build sets no VITE_APP_RELEASE_*, which is a bundle whose deploy named no release.
  it('shows none for a bundle built without one, which is what it shows when nothing is passed', () => {
    assert.equal(releaseLine(render()), null);
  });

  it('prints the release as text, so a release that is not one shows its characters and not markup', () => {
    const html = render({ label: '<b>x</b>', commit: null });

    assert.equal(releaseLine(html)?.value, '&lt;b&gt;x&lt;/b&gt;');
    assert.doesNotMatch(html, /<b>/);
  });
});

describe('the release a bundle was built with', () => {
  it('takes a label and a whole commit', () => {
    assert.deepEqual(playerRelease(LABEL, COMMIT), { label: LABEL, commit: COMMIT });
  });

  it('is nothing without a label to show, whatever the commit', () => {
    assert.equal(playerRelease(undefined, COMMIT), null);
    assert.equal(playerRelease('', COMMIT), null);
  });

  it('is nothing for a label in any other shape than the one a deploy accepts', () => {
    for (const label of ['QA build', 'a$(id)', 'x\ny', '<b>x</b>', 'a'.repeat(97)]) {
      assert.equal(playerRelease(label, COMMIT), null, label);
    }
    assert.deepEqual(playerRelease('a'.repeat(96), null), { label: 'a'.repeat(96), commit: null });
  });

  it('keeps the label and drops a commit that is not a whole one', () => {
    for (const commit of [undefined, '', '1702aff1b', COMMIT.toUpperCase(), `${COMMIT}0`]) {
      assert.deepEqual(playerRelease(LABEL, commit), { label: LABEL, commit: null }, String(commit));
    }
  });

  it('is shown by the display rule', () => {
    assert.equal(playerReleaseText({ label: LABEL, commit: COMMIT }), 'QA-build-2026-10-07 (1702aff1b)');
    assert.equal(playerReleaseText({ label: '1702aff1b', commit: COMMIT }), '1702aff1b');
    assert.equal(playerReleaseText({ label: LABEL, commit: null }), LABEL);
  });

  /**
   * Read once, when the config module loads, out of the two build-time variables the deploy sets, so
   * each case loads a fresh copy of the module under the variables it states.
   */
  async function configRelease(): Promise<PlayerRelease | null> {
    vi.resetModules();
    const { config } = await import('../src/utils/config');
    return config.release;
  }

  it('is read from VITE_APP_RELEASE_LABEL and VITE_APP_RELEASE_COMMIT', async () => {
    vi.stubEnv('VITE_APP_RELEASE_LABEL', LABEL);
    vi.stubEnv('VITE_APP_RELEASE_COMMIT', COMMIT);

    assert.deepEqual(await configRelease(), { label: LABEL, commit: COMMIT });
  });

  it('is null when the deploy named none, which builds both empty', async () => {
    vi.stubEnv('VITE_APP_RELEASE_LABEL', '');
    vi.stubEnv('VITE_APP_RELEASE_COMMIT', '');

    assert.equal(await configRelease(), null);
  });
});
