import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_BADGE_TEXT,
  ARCHIVE_UNLISTED_TEXT,
  type ArchivedStream,
  type StreamArchiveSummary,
} from '@streaming-monorepo/web2-admin-common';

import { ArchiveBadge, archiveBadgeHint } from '../components/archive/ArchiveBadge';
import { ARCHIVE_PAGE_INTRO, ArchivePage, NO_ARCHIVES, QUALITY_STATE_TEXT } from '../pages/ArchivePage';
import { StreamsPage } from '../pages/StreamsPage';
import { makeArchiveStamp, makeArchiveStamps } from './fundingFixtures';
import { jsonError, jsonOk, makeStream, mockFetch, renderWithProviders } from './helpers';

const ARCHIVE_STREAMS = '/api/archive/streams';
const ARCHIVE_STAMPS = '/api/archive/stamps';
const TALKS = '9a'.repeat(32);
const OLD = '9b'.repeat(32);

function summary(over: Partial<StreamArchiveSummary> = {}): StreamArchiveSummary {
  return { state: 'complete', archived: ['1080p', '720p'], archivedOnly: false, ...over };
}

/** A stream with 1080p archived, 720p with reduced protection, and 360p outdated, on two stamps. */
function makeArchivedStream(over: Partial<ArchivedStream> = {}): ArchivedStream {
  return {
    streamId: 's1',
    title: 'Opening talk',
    date: '2026-11-02',
    summary: summary(),
    qualities: [
      {
        rendition: '1080p',
        label: '1080p',
        state: 'complete',
        batchId: TALKS,
        batchLabel: 'Talks',
        bytes: 2_700_000_000,
        parityMissing: 0,
        batchTtlSeconds: 200 * 86_400,
      },
      {
        rendition: '720p',
        label: '720p',
        state: 'reduced',
        batchId: TALKS,
        batchLabel: 'Talks',
        bytes: 1_300_000_000,
        parityMissing: 12,
        batchTtlSeconds: 200 * 86_400,
      },
      {
        rendition: '360p',
        label: '360p',
        state: 'outdated',
        batchId: OLD,
        batchLabel: null,
        bytes: 400_000_000,
        parityMissing: 0,
        batchTtlSeconds: 20 * 86_400,
      },
    ],
    bytes: 4_000_000_000,
    archivedAt: '2026-11-03T10:00:00.000Z',
    archivedBy: 'admin',
    ...over,
  };
}

function serve(streams: ArchivedStream[] | Response) {
  return mockFetch([
    { path: ARCHIVE_STREAMS, respond: () => (Array.isArray(streams) ? jsonOk({ streams }) : streams) },
    {
      path: ARCHIVE_STAMPS,
      respond: () =>
        jsonOk(
          makeArchiveStamps({
            stamps: [makeArchiveStamp(), makeArchiveStamp({ batchId: OLD, label: null, expiresSoon: true })],
          }),
        ),
    },
  ]);
}

describe('the archive badge', () => {
  it('says each state in the words of the contract, and nothing for a stream with nothing copied', () => {
    for (const state of ['partial', 'complete', 'reduced', 'unlisted', 'outdated', 'expired'] as const) {
      const { unmount } = render(<ArchiveBadge archive={summary({ state })} />);
      expect(screen.getByText(ARCHIVE_BADGE_TEXT[state] as string)).toBeInTheDocument();
      unmount();
    }
    const { container } = render(<ArchiveBadge archive={summary({ state: 'none', archived: [] })} />);
    expect(container).toBeEmptyDOMElement();
    const absent = render(<ArchiveBadge archive={undefined} />);
    expect(absent.container).toBeEmptyDOMElement();
  });

  it('names the archived qualities on hover, and whether only they are listed', () => {
    expect(archiveBadgeHint(summary())).toBe('Archived: 1080p, 720p.');
    expect(archiveBadgeHint(summary({ archivedOnly: true }))).toBe(
      'Archived: 1080p, 720p. The catalogue lists only these.',
    );
    expect(archiveBadgeHint(summary({ state: 'partial', archived: [] }))).toBeNull();
  });

  it('shows under the status in the stream list', async () => {
    mockFetch([
      {
        path: '/api/streams',
        respond: () =>
          jsonOk({
            streams: [
              makeStream({ title: 'Archived one', status: 'vod', archive: summary() }),
              makeStream({ title: 'Plain one', status: 'vod' }),
            ],
          }),
      },
    ]);
    renderWithProviders(<StreamsPage />);
    const row = within((await screen.findByText('Archived one')).closest('tr') as HTMLElement);
    expect(row.getByText('Archived')).toBeInTheDocument();
    const plain = within(screen.getByText('Plain one').closest('tr') as HTMLElement);
    expect(plain.queryByText(/^Archive/)).not.toBeInTheDocument();
  });
});

describe('the Archive page', () => {
  it('lists each archived stream with its qualities, size, stamps, and when and by whom', async () => {
    serve([makeArchivedStream()]);
    renderWithProviders(<ArchivePage />);

    expect(screen.getByText(ARCHIVE_PAGE_INTRO)).toBeInTheDocument();
    const row = within((await screen.findByRole('link', { name: 'Opening talk' })).closest('tr') as HTMLElement);
    expect(row.getByRole('link', { name: 'Opening talk' })).toHaveAttribute('href', '/streams/s1');
    expect(row.getByText('Archived')).toBeInTheDocument();
    expect(row.getByText('2026-11-02')).toBeInTheDocument();
    expect(row.getByText(`1080p: ${QUALITY_STATE_TEXT.complete}`)).toBeInTheDocument();
    expect(row.getByText(`720p: ${QUALITY_STATE_TEXT.reduced}, 12 parity chunks missing`)).toBeInTheDocument();
    expect(row.getByText(`360p: ${QUALITY_STATE_TEXT.outdated}`)).toBeInTheDocument();
    expect(row.getByText('4 GB')).toBeInTheDocument();
    expect(row.getAllByText(/^Talks/)).toHaveLength(2);
    expect(row.getAllByText('· 200 days left')).toHaveLength(2);
    expect(row.getByText(/^9b9b9b9b…9b9b9b/)).toHaveAttribute('title', OLD);
    expect(row.getByText('by admin')).toBeInTheDocument();
    // With no panel to open, no action is offered.
    expect(row.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says of a quality on a stamp the manager no longer lists that it cannot be topped up', async () => {
    const [first] = makeArchivedStream().qualities;
    serve([
      makeArchivedStream({
        summary: summary({ state: 'unlisted', archived: ['1080p'] }),
        qualities: [{ ...first!, state: 'unlisted' }],
      }),
    ]);
    renderWithProviders(<ArchivePage />);

    const row = within((await screen.findByRole('link', { name: 'Opening talk' })).closest('tr') as HTMLElement);
    expect(row.getByText('Archive stamp not listed')).toBeInTheDocument();
    expect(row.getByText(`1080p: ${QUALITY_STATE_TEXT.unlisted}`)).toBeInTheDocument();
    expect(row.getByText(ARCHIVE_UNLISTED_TEXT)).toBeInTheDocument();
  });

  it('opens the panel to archive more qualities, and again with the outdated ones ticked', async () => {
    serve([makeArchivedStream(), makeArchivedStream({ streamId: 's2', title: 'Panel', qualities: [] })]);
    const onArchive = vi.fn();
    renderWithProviders(<ArchivePage onArchive={onArchive} />);

    const first = within((await screen.findByRole('link', { name: 'Opening talk' })).closest('tr') as HTMLElement);
    fireEvent.click(first.getByRole('button', { name: 'Archive again' }));
    expect(onArchive).toHaveBeenLastCalledWith('s1', ['360p']);
    fireEvent.click(first.getByRole('button', { name: 'Archive more qualities' }));
    expect(onArchive).toHaveBeenLastCalledWith('s1');

    const second = within(screen.getByRole('link', { name: 'Panel' }).closest('tr') as HTMLElement);
    expect(second.queryByRole('button', { name: 'Archive again' })).not.toBeInTheDocument();
  });

  it('says when no stream is archived yet', async () => {
    serve([]);
    renderWithProviders(<ArchivePage />);
    expect(await screen.findByText(NO_ARCHIVES)).toBeInTheDocument();
  });

  it('says why the archive could not be read, and reads it again on Retry', async () => {
    const fetchMock = serve(jsonError(500, { error: 'internal_error' }));
    renderWithProviders(<ArchivePage />);
    expect(await screen.findByText('The server hit an unexpected error.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === ARCHIVE_STREAMS)).toHaveLength(2);
  });
});
