import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogueMoveStatus, CatalogueMoveSummary } from '@streaming-monorepo/web2-admin-common';

import { moveDoneText } from '../components/stages/CatalogueMoveCard';
import { StagesPage } from '../pages/StagesPage';
import { jsonError, jsonOk, mockFetch, renderWithProviders } from './helpers';

const STAGES = '/api/stages';
const STAMP = '/api/catalogue-stamp';
const MOVE = '/api/catalogue-stamp/move';
const OLD = 'a1'.repeat(32);
const NEW = 'b2'.repeat(32);

function summary(over: Partial<CatalogueMoveSummary> = {}): CatalogueMoveSummary {
  return {
    id: '1',
    state: 'running',
    targetBatchId: NEW,
    fromBatchId: OLD,
    slotsDone: 2,
    slotsTotal: 5,
    restamped: 2,
    skipped: 0,
    thumbnails: 0,
    error: null,
    startedBy: 'alice',
    startedAt: '2026-09-28T10:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

const WAITING = { targetBatchId: NEW, fromBatchId: OLD, slots: 5 };

function serve(move: CatalogueMoveStatus | undefined, started?: CatalogueMoveStatus) {
  return mockFetch([
    { path: STAGES, respond: () => jsonOk({ stages: [] }) },
    { path: STAMP, respond: () => jsonOk({ catalogueStamp: null, ...(move ? { catalogueMove: move } : {}) }) },
    {
      path: MOVE,
      method: 'POST',
      respond: () =>
        started
          ? jsonOk(started)
          : jsonError(409, {
              error: 'catalogue_move_refused',
              problem: 'changed',
              message: 'The manager designates another batch.',
            }),
    },
  ]);
}

describe('the catalogue move on the Stages page', () => {
  it('shows nothing when no move waits, runs or just finished, and when the admin answers without one', async () => {
    serve({ enabled: true, waiting: null, refusal: null, latest: null });
    const { unmount } = renderWithProviders(<StagesPage />);
    expect(await screen.findByText('No stages yet.')).toBeInTheDocument();
    expect(screen.queryByText('Catalogue move')).not.toBeInTheDocument();
    unmount();

    serve(undefined);
    renderWithProviders(<StagesPage />);
    expect(await screen.findByText('No stages yet.')).toBeInTheDocument();
    expect(screen.queryByText('Catalogue move')).not.toBeInTheDocument();
  });

  it('says the move is not yet enabled on this installation, and offers no button', async () => {
    serve({
      enabled: false,
      waiting: WAITING,
      refusal: {
        problem: 'disabled',
        message: 'Moving the catalogue to another batch is not yet enabled on this installation.',
      },
      latest: null,
    });
    renderWithProviders(<StagesPage />);

    expect(await screen.findByText(/not yet enabled on this installation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move the catalogue/ })).not.toBeInTheDocument();
  });

  it('starts the move to the batch it names once the operator confirms, and shows its progress', async () => {
    const fetchMock = serve(
      { enabled: true, waiting: WAITING, refusal: null, latest: null },
      { enabled: true, waiting: WAITING, refusal: null, latest: summary() },
    );
    renderWithProviders(<StagesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Move the catalogue to batch b2b2b2b2…b2b2b2' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Every slot of the catalogue, 5 of them/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move the catalogue' }));

    expect(await screen.findByText(/Moving the catalogue to batch b2b2b2b2…b2b2b2: 2 of 5 slots/)).toBeInTheDocument();
    expect(screen.getByLabelText('Catalogue move progress')).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url, init]) => String(url) === MOVE && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ targetBatchId: NEW });
  });

  it('says why a start was refused', async () => {
    serve({ enabled: true, waiting: WAITING, refusal: null, latest: null });
    renderWithProviders(<StagesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Move the catalogue to batch/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move the catalogue' }));

    expect(await screen.findByText('The manager designates another batch.')).toBeInTheDocument();
  });

  it('shows where a failed move stopped and why, and offers to retry it', async () => {
    serve({
      enabled: true,
      waiting: WAITING,
      refusal: null,
      latest: summary({ state: 'failed', error: 'Slot 2 could not be moved: the node answered 500' }),
    });
    renderWithProviders(<StagesPage />);

    expect(
      await screen.findByText('The move stopped at slot 2: Slot 2 could not be moved: the node answered 500'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry the move' })).toBeInTheDocument();
  });

  it('says the move is done and that the previous batch can be released in the manager', async () => {
    const done = summary({ state: 'done', slotsDone: 5, restamped: 5, finishedAt: '2026-09-28T10:10:00.000Z' });
    serve({ enabled: true, waiting: null, refusal: null, latest: done });
    renderWithProviders(<StagesPage />);

    await waitFor(() => expect(screen.getByText(/You can now release the previous batch/)).toBeInTheDocument());
    expect(moveDoneText(done)).toBe(
      'The catalogue was moved to batch b2b2b2b2…b2b2b2: 5 slots, and the admin writes with it now. You can now release the previous batch, a1a1a1a1…a1a1a1, in the manager.',
    );
    expect(moveDoneText({ ...done, fromBatchId: null })).not.toMatch(/release/);
  });
});
