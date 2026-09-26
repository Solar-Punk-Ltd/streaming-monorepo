import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StreamsPage } from '../pages/StreamsPage';
import {
  jsonError,
  jsonOk,
  makeStream,
  mockFetch,
  pendingFetch,
  renderWithProviders,
} from './helpers';

const STREAMS = '/api/streams';

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
    expect(
      screen.getByRole('button', { name: /Create New Stream/ }),
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText('The server hit an unexpected error.'),
    ).toBeInTheDocument();
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
    expect(
      screen.queryByAltText('Without image thumbnail'),
    ).not.toBeInTheDocument();
  });
});
