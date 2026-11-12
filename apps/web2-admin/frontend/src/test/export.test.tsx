import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ExportOptionsResponse, ExportSummary, Stream } from '@streaming-monorepo/web2-admin-common';

import { ExportPanel } from '../components/export/ExportPanel';
import { ExportProvider } from '../components/export/ExportProvider';
import { formatUtc } from '../components/export/exportText';
import { ExportWidget } from '../components/export/ExportWidget';
import { StreamDetailsPage } from '../pages/StreamDetailsPage';
import { jsonOk, makeIngest, makeStream, mockFetch, renderWithProviders, type Route as MockRoute } from './helpers';

const ID = '7d3c0e5a-2a8b-4f61-9c1e-3b2a1f0e9d8c';
const EXPORT_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function makeExport(overrides: Partial<ExportSummary> = {}): ExportSummary {
  return {
    id: EXPORT_ID,
    streamId: ID,
    streamTitle: 'Opening keynote',
    rendition: '1080p',
    quality: '1080p',
    state: 'reading',
    pauseReason: null,
    pauseMessage: null,
    pausedAt: null,
    segmentsTotal: 100,
    segmentsRead: 25,
    segmentsMissing: 0,
    bytesRead: 250_000_000,
    estimatedBytes: 1_000_000_000,
    durationSeconds: 200,
    fileName: null,
    sizeBytes: null,
    partial: false,
    startedBy: 'other-operator',
    startedByYou: false,
    startedAt: '2026-11-10T10:00:00.000Z',
    finishedAt: null,
    dismissed: false,
    actions: ['pause', 'cancel'],
    ...overrides,
  };
}

const OPTIONS: ExportOptionsResponse = {
  streamId: ID,
  title: 'Opening keynote',
  date: '2026-11-05',
  durationSeconds: 3854,
  qualities: [
    {
      rendition: '1080p',
      label: '1080p',
      width: 1920,
      height: 1080,
      durationSeconds: 3854,
      estimatedBytes: 2_100_000_000,
      unavailable: null,
    },
    {
      rendition: '720p',
      label: '720p',
      width: 1280,
      height: 720,
      durationSeconds: 3854,
      estimatedBytes: 1_000_000_000,
      unavailable: null,
    },
  ],
  refusal: null,
  current: null,
};

function pageRoutes(stream: Stream, current: ExportSummary | null, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: `/api/streams/${ID}`, respond: () => jsonOk(stream) },
    { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest()) },
    {
      path: '/api/config',
      respond: () => jsonOk({ feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff' }, viewerBaseUrl: null }),
    },
    { path: '/api/export', respond: () => jsonOk({ export: current }) },
  ];
}

/** The details page as the shell shows it: inside the export's provider, with the widget and the panel. */
function renderPage() {
  return renderWithProviders(
    <ExportProvider>
      <Routes>
        <Route
          path="/streams/:id"
          element={
            <>
              <StreamDetailsPage />
              <ExportWidget />
              <ExportPanel />
            </>
          }
        />
      </Routes>
    </ExportProvider>,
    { route: `/streams/${ID}` },
  );
}

const recorded = () => makeStream({ id: ID, status: 'vod', manifestIndex: 12, durationSeconds: 3854 });

describe('formatUtc', () => {
  it('gives the moment in UTC to the second, whatever zone it was written in, and says so when there is none', () => {
    expect(formatUtc('2026-11-12T09:51:10.123Z')).toBe('2026-11-12 09:51:10 UTC');
    expect(formatUtc('2026-11-12T10:51:10+01:00')).toBe('2026-11-12 09:51:10 UTC');
    expect(formatUtc(null)).toBe('an unknown time');
    expect(formatUtc('not a date')).toBe('an unknown time');
  });
});

describe('exporting a recording', () => {
  it('offers Download on a recording, published or not, and not on a stream that is live', async () => {
    mockFetch(pageRoutes(recorded(), null));
    const { unmount } = renderPage();
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    unmount();

    mockFetch(pageRoutes(makeStream({ id: ID, status: 'draft', manifestIndex: 12 }), null));
    const draft = renderPage();
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    draft.unmount();

    mockFetch(pageRoutes(makeStream({ id: ID, status: 'live', manifestIndex: null }), null));
    renderPage();
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('opens the panel with the qualities and their sizes, and starts the one chosen', async () => {
    const started = makeExport({
      rendition: '720p',
      quality: '720p',
      segmentsRead: 0,
      startedByYou: true,
      startedBy: 'test-operator',
    });
    const fetchMock = mockFetch(
      pageRoutes(recorded(), null, [
        { path: `/api/streams/${ID}/export`, respond: () => jsonOk(OPTIONS) },
        { path: `/api/streams/${ID}/export`, method: 'POST', respond: () => jsonOk(started, 201) },
      ]),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('About 2.1 GB')).toBeInTheDocument();
    expect(within(panel).getByText('About 1.0 GB')).toBeInTheDocument();
    fireEvent.click(within(panel).getByLabelText(/720p/));
    fireEvent.click(within(panel).getByRole('button', { name: 'Start export' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ rendition: '720p' });
    });
    expect(await within(panel).findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(panel).getByText('720p · started by you at 2026-11-10 10:00:00 UTC')).toBeInTheDocument();
    // The stream's page says when the running export started as well, behind the open dialog.
    const card = screen.getByRole('region', { name: 'downloaded file', hidden: true });
    expect(within(card).getByText('Started by you at 2026-11-10 10:00:00 UTC')).toBeInTheDocument();
    // The widget shows the running export with the panel open too; the open dialog hides the page from
    // assistive technology, as a modal does, so it is found among the hidden.
    expect(screen.getByRole('status', { name: 'export', hidden: true })).toHaveTextContent('Opening keynote · 720p');
  });

  it('brings the panel to front for the user who started an export that paused on unreadable segments', async () => {
    mockFetch(
      pageRoutes(
        recorded(),
        makeExport({
          state: 'paused',
          pauseReason: 'unreadable',
          pauseMessage: '3 of 100 segments could not be read from Swarm.',
          pausedAt: '2026-11-10T10:05:00.000Z',
          startedByYou: true,
          actions: ['resume', 'save', 'cancel'],
        }),
      ),
    );
    renderPage();

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('3 of 100 segments could not be read from Swarm.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Try them again' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save without them' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Cancel export' })).toBeInTheDocument();
  });

  it('leaves the panel closed for everyone else, whose widget says the export needs a decision', async () => {
    mockFetch(
      pageRoutes(
        recorded(),
        makeExport({
          state: 'paused',
          pauseReason: 'live',
          pauseMessage: 'The stream went live again.',
          pausedAt: '2026-11-10T10:05:00.000Z',
          actions: ['save', 'wait', 'cancel'],
        }),
      ),
    );
    renderPage();

    const widget = await screen.findByRole('status', { name: 'export' });
    expect(within(widget).getByText('Paused: needs a decision')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(widget);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByRole('button', { name: 'Wait until it finishes' })).toBeInTheDocument();
    expect(within(panel).getByText(/started by other-operator/)).toBeInTheDocument();
  });

  it('shows the kept file above the OBS details and in the widget, to save, and closes the widget on request', async () => {
    const done = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss'],
    });
    const fetchMock = mockFetch(
      pageRoutes(recorded(), done, [
        {
          path: `/api/export/${EXPORT_ID}/actions`,
          method: 'POST',
          respond: () => jsonOk({ export: { ...done, dismissed: true, actions: [] } }),
        },
      ]),
    );
    renderPage();

    const card = await screen.findByRole('region', { name: 'downloaded file' });
    expect(within(card).getByText('opening-keynote-2026-11-05-1080p.mp4')).toBeInTheDocument();
    expect(
      within(card).getByText('Started 2026-11-10 10:00:00 UTC, finished 2026-11-10 10:20:00 UTC'),
    ).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Save file/ })).toHaveAttribute(
      'href',
      `/api/export/${EXPORT_ID}/file`,
    );

    const widget = screen.getByRole('status', { name: 'export' });
    expect(within(widget).getByText('Ready to save, 2.1 GB')).toBeInTheDocument();
    fireEvent.click(within(widget).getByRole('button', { name: 'close the export' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'export' })).not.toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: 'dismiss' });
    // The file stays on the page to save again.
    expect(screen.getByRole('region', { name: 'downloaded file' })).toBeInTheDocument();
  });
});
