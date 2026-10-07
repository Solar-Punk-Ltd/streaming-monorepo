/**
 * The Release a version card shows beside the build it names.
 *
 * Unit test: the card rendered to markup on the server, under the app's own
 * theme, with no browser. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThemeProvider } from '@mui/material';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { StackVersion } from '@streaming-infra-manager/common';

import { theme } from '../app/theme';
import { VersionCard } from './VersionCard';

const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';

function version(over: Partial<StackVersion> = {}): StackVersion {
  return {
    id: 1,
    name: 'bundled',
    gitRef: COMMIT,
    commitSha: COMMIT,
    status: 'ready',
    isDefault: true,
    tested: true,
    testedInvalidatedAt: null,
    builtAt: '2026-10-07T10:00:00.000Z',
    lastError: null,
    contract: null,
    deployments: 0,
    layout: 'builds',
    buildId: COMMIT,
    previousBuildId: null,
    buildLabel: null,
    source: { url: 'https://github.com/example/streaming-monorepo.git', folder: 'apps/hls-stream' },
    ...over,
  };
}

function rendered(shown: StackVersion): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(VersionCard, {
        version: shown,
        busy: false,
        buildingElsewhere: false,
        onUpdate: () => {},
        onSetDefault: () => {},
        onSetTested: () => {},
        onRemove: () => {},
      }),
    ),
  );
}

/** The style elements the server render puts beside every styled element, which say nothing about the content. */
const STYLES = /<style[^>]*>.*?<\/style>/g;

/** The value of one fact of the card's list, as the markup has it, or null when the card has no such fact. */
function fact(html: string, label: string): string | null {
  const match = new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>(.*?)</dd>`).exec(html.replace(STYLES, ''));
  return match ? (match[1] ?? '') : null;
}

describe("a version card's Release", () => {
  it("names the current build's release and the first nine characters of its commit, with the whole commit for a title", () => {
    const value = fact(rendered(version({ buildLabel: 'QA-build-2026-10-07' })), 'Release');

    assert.match(
      value ?? '',
      new RegExp(`<span[^>]*title="${COMMIT}"[^>]*>QA-build-2026-10-07 \\(635b4e175\\)</span>`),
    );
  });

  it('shows a label that already starts with the commit alone', () => {
    const value = fact(rendered(version({ buildLabel: '635b4e175-dirty' })), 'Release');

    assert.match(value ?? '', />635b4e175-dirty</);
    assert.doesNotMatch(value ?? '', /\(635b4e175\)/);
  });

  it('is not there for a build made with none, and for a version with no build of its own', () => {
    assert.equal(fact(rendered(version()), 'Release'), null);
    assert.equal(fact(rendered(version({ layout: 'legacy', buildId: null })), 'Release'), null);
    assert.notEqual(fact(rendered(version()), 'Built'), null, 'the facts beside it are still there');
  });
});
