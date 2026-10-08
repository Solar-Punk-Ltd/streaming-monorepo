/**
 * The release a deployment's page says its containers run, in the At a glance
 * card beside the commit they run: the player's version on a Watch a stream
 * deployment, the release on any other.
 *
 * Unit test: the card rendered to markup on the server, under the app's own
 * theme, with no browser. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThemeProvider } from '@mui/material';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { type StackVersion, stampHealthFrom } from '@streaming-infra-manager/common';

import { theme } from '../app/theme';
import type { Container, Profile } from '../types';
import { AtAGlanceCard } from './AtAGlanceCard';

const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';
const OLDER = 'b'.repeat(40);
const LABEL = 'QA-build-2026-10-07';

const running = (service: string, buildLabel: string | null = LABEL, buildCommit = COMMIT): Container => ({
  service,
  ports: {},
  buildId: buildCommit,
  buildCommit,
  buildLabel,
});

const stream = (overrides: Partial<Profile> = {}): Profile => ({
  name: 'main-stage',
  kind: 'streamer',
  port_slot: 1,
  notes: null,
  notes_revision: 0,
  status: 'RUNNING',
  last_error: null,
  last_error_at: null,
  last_full_deploy_commit: COMMIT,
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
  engine_settings: {},
  has_private_key: false,
  has_rpc_endpoint: false,
  has_srt_passphrase: false,
  has_engine_config: false,
  engine_config_error: null,
  engine_config_state: null,
  instance_id: '00000000-0000-4000-8000-000000000007',
  engine_config_revision: 0,
  intent_revision: 0,
  stamp_id: null,
  containers: [running('srs'), running('stream-uploader'), running('bee-uploader')],
  ...overrides,
});

const watch = (containers: Container[] = [running('client'), running('bee-gateway')]): Profile =>
  stream({ name: 'watch-main', kind: 'viewer', containers });

const VERSION: StackVersion = {
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
  deployments: 2,
  layout: 'builds',
  buildId: COMMIT,
  previousBuildId: null,
  buildLabel: 'QA-build-2026-10-08',
  source: { url: 'https://github.com/example/streaming-monorepo.git', folder: 'apps/hls-stream' },
};

function rendered(profile: Profile): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(AtAGlanceCard, {
        profile,
        serverHost: 'stage.example.invalid',
        readiness: { label: 'Containers running', tone: 'ok' },
        stampHealth: stampHealthFrom(null, null),
        group: null,
        version: VERSION,
        engineOverview: null,
        engineLoadError: null,
        savedNotApplied: [],
      }),
    ),
  ).replace(/<style[^>]*>.*?<\/style>/g, '');
}

/** The value of one row of the card, as the markup has it, or null when the card has no such row. */
function row(html: string, key: string): string | null {
  return new RegExp(`<dt[^>]*>${key}</dt><dd[^>]*>(.*?)</dd>`).exec(html)?.[1] ?? null;
}

const SHOWN = new RegExp(`<span[^>]*title="${COMMIT}"[^>]*>${LABEL} \\(635b4e175\\)</span>`);

describe("the release a deployment's page says it runs", () => {
  it('is the release of the build its containers run, with the whole commit for a title', () => {
    const html = rendered(stream());

    assert.match(row(html, 'Release') ?? '', SHOWN);
    assert.equal(row(html, 'Player'), null);
    assert.match(row(html, 'Running') ?? '', /commit 635b4e1/, 'beside what the containers run');
  });

  it("is the player's version on a Watch a stream deployment", () => {
    const html = rendered(watch());

    assert.match(row(html, 'Player') ?? '', SHOWN);
    assert.equal(row(html, 'Release'), null);
  });

  it("is what the containers run, not the release the version's newer build carries", () => {
    assert.doesNotMatch(rendered(stream()), /QA-build-2026-10-08/);
  });

  it('is not there when the build carries none, when nothing was observed, or when the containers disagree', () => {
    const none = [running('client', null), running('bee-gateway', null)];
    const unanswered = [{ service: 'client', ports: {}, buildId: COMMIT, buildCommit: COMMIT }];
    const disagreeing = [running('client'), running('bee-gateway', 'QA-build-2026-10-06', OLDER)];
    for (const containers of [none, unanswered, disagreeing, []]) {
      const html = rendered(watch(containers));
      assert.equal(row(html, 'Player'), null, JSON.stringify(containers));
      assert.equal(row(html, 'Release'), null, JSON.stringify(containers));
      assert.notEqual(row(html, 'Running'), null, 'the commit row stays');
    }
  });
});
