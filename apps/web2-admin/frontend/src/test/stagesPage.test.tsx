import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogueStampSummary, StageSummary } from '@streaming-monorepo/web2-admin-common';

import { formatAgo } from '../dateUtil';
import { formatTimeLeft } from '../format';
import { stampConcern } from '../components/stages/stamps';
import { StagesPage } from '../pages/StagesPage';
import { jsonError, jsonOk, makeStage, minutesAgo, mockFetch, pendingFetch, renderWithProviders } from './helpers';

const STAGES = '/api/stages';
const STAMP = '/api/catalogue-stamp';

function makeStamp(overrides: Partial<CatalogueStampSummary> = {}): CatalogueStampSummary {
  return {
    nodeName: 'catalogue-node',
    batchId: 'c2'.repeat(32),
    immutable: true,
    depth: 22,
    state: 'active',
    ttlSeconds: 30 * 86_400,
    fillRatio: 0.01,
    designatedAt: '2026-09-27T09:00:00.000Z',
    observedAt: minutesAgo(1),
    receivedAt: minutesAgo(1),
    ...overrides,
  };
}

function serve(stages: StageSummary[], catalogueStamp: CatalogueStampSummary | null) {
  return mockFetch([
    { path: STAGES, respond: () => jsonOk({ stages }) },
    { path: STAMP, respond: () => jsonOk({ catalogueStamp }) },
  ]);
}

describe('StagesPage', () => {
  it('shows a spinner while the stages are loading', () => {
    pendingFetch();
    renderWithProviders(<StagesPage />);

    expect(screen.getByLabelText('Loading stages')).toBeInTheDocument();
  });

  it('explains where stages come from when there are none, and that no catalogue batch is designated', async () => {
    serve([], null);
    renderWithProviders(<StagesPage />);

    expect(await screen.findByText('No stages yet.')).toBeInTheDocument();
    expect(screen.getByText(/once the manager's admin link points at this admin/)).toBeInTheDocument();
    expect(screen.getByText('The manager has not designated a catalogue batch yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the API error with a retry action', async () => {
    mockFetch([
      { path: STAGES, respond: () => jsonError(500, { error: 'internal_error' }) },
      { path: STAMP, respond: () => jsonOk({ catalogueStamp: null }) },
    ]);
    renderWithProviders(<StagesPage />);

    expect(await screen.findByText('The server hit an unexpected error.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('lists a stage with its readiness, ingest address, rung readings and when it was last confirmed', async () => {
    serve(
      [
        makeStage({
          readiness: { tone: 'warning', reasons: ['720p: the batch has less than two days left'] },
          rungs: [
            {
              name: '720p',
              stamp: {
                batchId: 'b1'.repeat(32),
                state: 'active',
                ttlSeconds: 20 * 3600,
                fillRatio: 0.5,
                immutable: false,
              },
              chequebook: { health: 'low', availableBzz: '0.1' },
            },
          ],
        }),
      ],
      makeStamp(),
    );
    renderWithProviders(<StagesPage />);

    expect(await screen.findByText('Main stage')).toBeInTheDocument();
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText('720p: the batch has less than two days left')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('ingest.example.org:10061')).toBeInTheDocument();
    expect(screen.getByText(/SRT, with a passphrase/)).toBeInTheDocument();
    expect(screen.getByText('20 h 0 min left, 50% full (under 48 h)')).toBeInTheDocument();
    expect(screen.getByText('Chequebook low')).toBeInTheDocument();
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    expect(screen.queryByText(/Not supported yet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });

  it('marks a retired stage and an OvenMediaEngine one', async () => {
    serve(
      [
        makeStage({ stageId: '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60', name: 'Old stage', retiredAt: minutesAgo(60) }),
        makeStage({
          stageId: '7b2e4c0a-3d4e-4f60-9b62-2c3d4e5f6071',
          name: 'OME stage',
          engine: 'ome',
          supported: false,
        }),
      ],
      makeStamp(),
    );
    renderWithProviders(<StagesPage />);

    expect(await screen.findByText('Old stage')).toBeInTheDocument();
    expect(screen.getByText('Retired')).toBeInTheDocument();
    expect(screen.getByText('Not supported yet (OvenMediaEngine)')).toBeInTheDocument();
  });

  it('says which token each stage’s uploader presents, and that a shared one is refused until it is rotated', async () => {
    serve(
      [
        makeStage({ name: 'Main stage', adminTokenKind: 'own' }),
        makeStage({ stageId: '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60', name: 'Old stage', adminTokenKind: 'shared' }),
        makeStage({ stageId: '7b2e4c0a-3d4e-4f60-9b62-2c3d4e5f6071', name: 'Hand stage', adminTokenKind: null }),
      ],
      makeStamp(),
    );
    renderWithProviders(<StagesPage />);

    const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;
    expect(within(await rowOf('Main stage')).getByText('Its own token')).toBeInTheDocument();
    expect(
      within(await rowOf('Old stage')).getByText(
        "Refused: not a token of its own. Rotate the uploader's admin token in the manager and redeploy the stage.",
      ),
    ).toBeInTheDocument();
    expect(within(await rowOf('Hand stage')).getByText('No token pushed')).toBeInTheDocument();
    expect(screen.getAllByText(/^Refused:/)).toHaveLength(1);
    expect(screen.queryByText(/shared token/)).toBeNull();
  });

  it('shows the catalogue stamp, and warns when it runs low or is gone', async () => {
    serve([], makeStamp({ ttlSeconds: 10 * 3600 }));
    const { unmount } = renderWithProviders(<StagesPage />);

    expect(await screen.findByText(/Batch c2c2c2c2…/)).toBeInTheDocument();
    expect(screen.getByText(/on catalogue-node/)).toBeInTheDocument();
    expect(screen.getByText('Immutable, depth 22')).toBeInTheDocument();
    expect(
      screen.getByText('The catalogue batch has less than 48 hours left. Top it up in the manager.'),
    ).toBeInTheDocument();
    unmount();

    serve([], makeStamp({ state: 'expired', ttlSeconds: 0 }));
    renderWithProviders(<StagesPage />);
    expect(
      await screen.findByText('The catalogue batch is expired. Nothing can be written to the catalogue with it.'),
    ).toBeInTheDocument();
  });

  it('does not warn about a stamp with days left', async () => {
    serve([makeStage()], makeStamp());
    renderWithProviders(<StagesPage />);

    expect(await screen.findByText('5 days 0 h left, 25% full')).toBeInTheDocument();
    expect(screen.queryByText(/less than 48 hours/)).not.toBeInTheDocument();
    expect(screen.queryByText(/under 48 h/)).not.toBeInTheDocument();
  });
});

describe('stage readings', () => {
  it('warn under 48 hours and when the batch is gone, and not when Bee cannot tell', () => {
    expect(stampConcern({ state: 'active', ttlSeconds: 47 * 3600 })).toBe('low');
    expect(stampConcern({ state: 'active', ttlSeconds: 48 * 3600 })).toBeNull();
    expect(stampConcern({ state: 'expired', ttlSeconds: null })).toBe('gone');
    expect(stampConcern({ state: 'gone', ttlSeconds: 100 * 86_400 })).toBe('gone');
    expect(stampConcern({ state: 'active', ttlSeconds: -1 })).toBeNull();
    expect(stampConcern(null)).toBeNull();
  });

  it('say how long ago and how long left in words', () => {
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    expect(formatAgo('2026-09-28T11:59:40.000Z', now)).toBe('less than a minute ago');
    expect(formatAgo('2026-09-28T11:59:00.000Z', now)).toBe('1 minute ago');
    expect(formatAgo('2026-09-28T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(formatAgo('2026-09-25T12:00:00.000Z', now)).toBe('3 days ago');
    expect(formatTimeLeft(40 * 60)).toBe('40 min');
    expect(formatTimeLeft(86_400 + 4 * 3600)).toBe('1 day 4 h');
    expect(formatTimeLeft(12 * 86_400)).toBe('12 days');
    expect(formatTimeLeft(-1)).toBe('—');
  });
});
