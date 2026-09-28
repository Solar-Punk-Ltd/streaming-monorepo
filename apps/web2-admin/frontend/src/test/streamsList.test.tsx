import { screen } from '@testing-library/react';
import type { CatalogueBatchReading, CatalogueWriteStatus } from '@streaming-monorepo/web2-admin-common';
import { describe, expect, it } from 'vitest';

import { StreamsPage } from '../pages/StreamsPage';
import { jsonError, jsonOk, makeStream, mockFetch, pendingFetch, renderWithProviders } from './helpers';

const STREAMS = '/api/streams';
const STAMP = '/api/catalogue-stamp';

describe('StreamsPage', () => {
  it('shows a spinner while the list is loading', () => {
    pendingFetch();
    renderWithProviders(<StreamsPage />);

    expect(screen.getByLabelText('Loading streams')).toBeInTheDocument();
    expect(screen.queryByText('No streams yet.')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no streams', async () => {
    mockFetch([{ path: STREAMS, respond: () => jsonOk({ streams: [] }) }]);
    renderWithProviders(<StreamsPage />);

    expect(await screen.findByText('No streams yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create New Stream/ })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the API error with a retry action', async () => {
    mockFetch([
      {
        path: STREAMS,
        respond: () => jsonError(500, { error: 'internal_error' }),
      },
    ]);
    renderWithProviders(<StreamsPage />);

    expect(await screen.findByText('The server hit an unexpected error.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders a row per stream with its status chip', async () => {
    const streams = [
      makeStream({ title: 'Draft one', status: 'draft' }),
      makeStream({
        title: 'Published one',
        status: 'published',
        publishedFeedIndex: 3,
        publishedAt: '2026-09-11T11:00:00.000Z',
      }),
      makeStream({
        title: 'Audio one',
        status: 'draft',
        mediaType: 'audio',
        publishError: 'bee upload failed: 502',
      }),
      makeStream({ title: 'Busy one', status: 'publishing' }),
    ];
    mockFetch([{ path: STREAMS, respond: () => jsonOk({ streams }) }]);

    renderWithProviders(<StreamsPage />);

    expect(await screen.findByText('Draft one')).toBeInTheDocument();
    expect(screen.getByText('Published one')).toBeInTheDocument();
    expect(screen.getAllByText('Draft')).toHaveLength(2);
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Publishing')).toBeInTheDocument();
    // The red chip only appears for the stream that carries a publish error.
    expect(screen.getAllByText('Publish failed')).toHaveLength(1);
    expect(screen.getByText('Audio Only')).toBeInTheDocument();
    expect(screen.getAllByText('Video Stream')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: 'Details' })).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(4);
  });

  it('shows a thumbnail image only for streams that have one', async () => {
    const streams = [
      makeStream({ title: 'With image', hasThumbnail: true }),
      makeStream({ title: 'Without image', hasThumbnail: false }),
    ];
    mockFetch([{ path: STREAMS, respond: () => jsonOk({ streams }) }]);

    renderWithProviders(<StreamsPage />);

    const image = await screen.findByAltText('With image thumbnail');
    expect(image.getAttribute('src')).toContain('/thumbnail?v=');
    expect(screen.queryByAltText('Without image thumbnail')).not.toBeInTheDocument();
  });
});

function batch(overrides: Partial<CatalogueBatchReading> = {}): CatalogueBatchReading {
  return {
    batchId: 'c2'.repeat(32),
    nodeName: 'catalogue-node',
    state: 'active',
    ttlSeconds: 30 * 86_400,
    fillRatio: 0.01,
    observedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

function serveWith(catalogueWrite: CatalogueWriteStatus) {
  mockFetch([
    { path: STREAMS, respond: () => jsonOk({ streams: [makeStream({ title: 'Draft one' })] }) },
    { path: STAMP, respond: () => jsonOk({ catalogueStamp: null, catalogueWrite }) },
  ]);
  renderWithProviders(<StreamsPage />);
}

describe('StreamsPage catalogue banner', () => {
  it('says why the admin refuses to write the catalogue, in the sentence it refuses with', async () => {
    const message =
      'The manager has not designated a catalogue batch yet. Nothing is written to the catalogue until it does.';
    serveWith({ batch: null, refusal: { problem: 'none', message }, moveWaitingTo: null });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('Draft one')).toBeInTheDocument();
  });

  it('warns when the batch has less than 48 hours left', async () => {
    serveWith({ batch: batch({ ttlSeconds: 47 * 3600 }), refusal: null, moveWaitingTo: null });

    expect(
      await screen.findByText('The catalogue batch c2c2c2c2… has less than 48 hours left. Top it up in the manager.'),
    ).toBeInTheDocument();
  });

  it('warns when the batch is 90% full, and not below', async () => {
    serveWith({ batch: batch({ fillRatio: 0.9 }), refusal: null, moveWaitingTo: null });

    expect(await screen.findByText(/^The catalogue batch c2c2c2c2… is 90% full\./)).toBeInTheDocument();
  });

  it('says nothing while the batch is fine', async () => {
    serveWith({ batch: batch({ fillRatio: 0.89 }), refusal: null, moveWaitingTo: null });

    expect(await screen.findByText('Draft one')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says a move to the designated batch is waiting, and which batch the catalogue is still written with', async () => {
    serveWith({ batch: batch(), refusal: null, moveWaitingTo: 'd3'.repeat(32) });

    expect(
      await screen.findByText(
        'A move to batch d3d3d3d3… is waiting. Until it runs, the catalogue is written with batch c2c2c2c2…, as the manager last read it 3 minutes ago.',
      ),
    ).toBeInTheDocument();
  });

  it('still lists the streams when the catalogue status cannot be read', async () => {
    mockFetch([
      { path: STREAMS, respond: () => jsonOk({ streams: [makeStream({ title: 'Draft one' })] }) },
      { path: STAMP, respond: () => jsonError(500, { error: 'internal_error' }) },
    ]);
    renderWithProviders(<StreamsPage />);

    expect(await screen.findByText('Draft one')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
