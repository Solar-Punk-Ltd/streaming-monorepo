import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_READ_HEADER,
  BACKGROUND_READ_VALUE,
  type ExportOptionsResponse,
  type ExportSummary,
  type Stream,
} from '@streaming-monorepo/web2-admin-common';

import { CLEAR_EXPORT_PROMPT, ExportPanel } from '../components/export/ExportPanel';
import { EXPORT_POLL_IDLE_MS, ExportProvider } from '../components/export/ExportProvider';
import { formatTook, formatUtc, statusLine } from '../components/export/exportText';
import { ExportWidget } from '../components/export/ExportWidget';
import { StreamDetailsPage } from '../pages/StreamDetailsPage';
import {
  jsonError,
  jsonOk,
  makeIngest,
  makeStream,
  mockFetch,
  renderWithProviders,
  type Route as MockRoute,
} from './helpers';

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

describe('formatTook', () => {
  it('says how long an export took, start to finish, in the largest two units, and nothing without both moments', () => {
    expect(formatTook('2026-11-12T12:33:50.789Z', '2026-11-12T12:34:35.100Z')).toBe('44 s');
    expect(formatTook('2026-11-12T12:33:50.789Z', '2026-11-12T12:34:58.034Z')).toBe('1 min 7 s');
    expect(formatTook('2026-11-10T10:00:00.000Z', '2026-11-10T10:20:00.000Z')).toBe('20 min');
    expect(formatTook('2026-11-10T10:00:00.000Z', '2026-11-10T11:04:14.000Z')).toBe('1 h 4 min');
    expect(formatTook('2026-11-10T10:00:00.000Z', '2026-11-10T11:00:20.000Z')).toBe('1 h');
    expect(formatTook('2026-11-10T10:00:00.000Z', null)).toBeNull();
    expect(formatTook('not a date', '2026-11-10T10:20:00.000Z')).toBeNull();
  });

  it('says 0 s from cache for an export that took under half a second', () => {
    expect(formatTook('2026-11-12T18:39:19.800Z', '2026-11-12T18:39:20.100Z')).toBe('0 s from cache');
    expect(formatTook('2026-11-12T18:39:19.800Z', '2026-11-12T18:39:20.400Z')).toBe('1 s');
  });
});

describe('statusLine', () => {
  it('keeps a word between the segment count and the bytes read, so the two never read as one number', () => {
    const reading = makeExport({ state: 'reading', segmentsRead: 18, segmentsTotal: 32, bytesRead: 4_200_000 });
    expect(statusLine(reading)).toBe('Reading from Swarm: 18 of 32 segments, 4 MB so far.');
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

  it('clears the kept file from the panel, after which the quality can be exported again', async () => {
    const done = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      partial: true,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
    const fetchMock = mockFetch(
      pageRoutes(recorded(), done, [
        { path: `/api/streams/${ID}/export`, respond: () => jsonOk(OPTIONS) },
        { path: `/api/export/${EXPORT_ID}/actions`, method: 'POST', respond: () => jsonOk({ export: null }) },
      ]),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    const panel = await screen.findByRole('dialog');
    // The chosen quality is the kept file, here a partial one: Save file, and Clear to export it again.
    expect(await within(panel).findByText(/This quality is on the server already/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Start export' })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText('Clear the kept file?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await within(panel).findByRole('button', { name: 'Start export' })).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: 'clear' });
  });

  it('opens the panel from the widget with a button a keyboard reaches, while an export runs', async () => {
    mockFetch(pageRoutes(recorded(), makeExport()));
    renderPage();

    const widget = await screen.findByRole('status', { name: 'export' });
    const open = within(widget).getByRole('button', { name: 'open the export' });
    open.focus();
    expect(open).toHaveFocus();
    fireEvent.click(open);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('says in the panel how long a finished export took', async () => {
    mockFetch(
      pageRoutes(
        recorded(),
        makeExport({
          state: 'done',
          fileName: 'opening-keynote-2026-11-05-1080p.mp4',
          sizeBytes: 2_100_000_000,
          finishedAt: '2026-11-10T10:20:00.000Z',
          actions: ['dismiss', 'clear'],
        }),
      ),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'open the export' }));
    const panel = await screen.findByRole('dialog');
    expect(
      within(panel).getByText('Ready: opening-keynote-2026-11-05-1080p.mp4, 2.1 GB. It took 20 min.'),
    ).toBeInTheDocument();
  });

  it('shows the kept file above the OBS details and in the widget, to save, and closes the widget on request', async () => {
    const done = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
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
      within(card).getByText('Started 2026-11-10 10:00:00 UTC, finished 2026-11-10 10:20:00 UTC, took 20 min'),
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

  it('offers Clear under Save file on the kept file card when the export allows it, and not when it does not', async () => {
    const done = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
    mockFetch(pageRoutes(recorded(), done));
    const first = renderPage();

    const card = await screen.findByRole('region', { name: 'downloaded file' });
    const save = within(card).getByRole('link', { name: /Save file/ });
    const clear = within(card).getByRole('button', { name: 'Clear' });
    expect(save.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(card).getByText(
        'Kept on the server until it is cleared or the next export starts, so saving it again reads nothing from Swarm.',
      ),
    ).toBeInTheDocument();
    first.unmount();

    mockFetch(pageRoutes(recorded(), { ...done, actions: ['dismiss'] }));
    renderPage();
    const without = await screen.findByRole('region', { name: 'downloaded file' });
    expect(within(without).getByRole('link', { name: /Save file/ })).toBeInTheDocument();
    expect(within(without).queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('asks before clearing the kept file from the card, and Keep it sends nothing', async () => {
    const done = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
    const fetchMock = mockFetch(pageRoutes(recorded(), done));
    renderPage();

    const card = await screen.findByRole('region', { name: 'downloaded file' });
    fireEvent.click(within(card).getByRole('button', { name: 'Clear' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Clear the kept file?')).toBeInTheDocument();
    expect(within(dialog).getByText(CLEAR_EXPORT_PROMPT)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.getByRole('region', { name: 'downloaded file' })).toBeInTheDocument();
  });

  it('clears the kept file from the card once confirmed, and the card goes', async () => {
    let kept: ExportSummary | null = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
    const fetchMock = mockFetch(
      pageRoutes(recorded(), null, [
        { path: '/api/export', respond: () => jsonOk({ export: kept }) },
        {
          path: `/api/export/${EXPORT_ID}/actions`,
          method: 'POST',
          respond: () => {
            kept = null;
            return jsonOk({ export: null });
          },
        },
      ]),
    );
    renderPage();

    const card = await screen.findByRole('region', { name: 'downloaded file' });
    fireEvent.click(within(card).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'downloaded file' })).not.toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: 'clear' });
  });

  it('keeps the kept file card and says so when clearing it fails', async () => {
    const done = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
    mockFetch(
      pageRoutes(recorded(), done, [
        {
          path: `/api/export/${EXPORT_ID}/actions`,
          method: 'POST',
          respond: () => jsonError(409, { error: 'export_changed', message: 'The export changed meanwhile.' }),
        },
      ]),
    );
    renderPage();

    const card = await screen.findByRole('region', { name: 'downloaded file' });
    fireEvent.click(within(card).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText('The export changed meanwhile.')).toBeInTheDocument();
    // The question stays open, as the panel's does, and the card is still there behind it.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'downloaded file' })).toBeInTheDocument();
  });
});

describe('an export that is no longer on the server', () => {
  const GONE = 'This export is no longer on the server. The page shows what is there now.';

  function done(): ExportSummary {
    return makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-1080p.mp4',
      sizeBytes: 2_100_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
  }

  /** The page with `current` on the server, whose actions all answer that the export is gone. */
  function renderGone(current: ExportSummary) {
    mockFetch(
      pageRoutes(recorded(), current, [
        {
          path: `/api/export/${EXPORT_ID}/actions`,
          method: 'POST',
          respond: () => jsonError(404, { error: 'export_not_found', id: EXPORT_ID }),
        },
      ]),
    );
    renderPage();
  }

  async function expectGoneSaid() {
    expect(await screen.findByText(GONE)).toBeInTheDocument();
    expect(screen.queryByText('export_not_found')).not.toBeInTheDocument();
  }

  it("says so in words when one of the panel's buttons acts on it", async () => {
    renderGone(makeExport());

    fireEvent.click(await screen.findByRole('button', { name: 'open the export' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pause' }));
    await expectGoneSaid();
  });

  it("says so in words when the panel's Clear acts on it", async () => {
    renderGone(done());

    fireEvent.click(await screen.findByRole('button', { name: 'open the export' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear' }));
    await screen.findByText('Clear the kept file?');
    const confirm = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clear' }));
    await expectGoneSaid();
  });

  it("says so in words when the kept file card's Clear acts on it", async () => {
    renderGone(done());

    const card = await screen.findByRole('region', { name: 'downloaded file' });
    fireEvent.click(within(card).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear' }));
    await expectGoneSaid();
  });

  it("says so in words when the widget's close acts on it", async () => {
    renderGone(done());

    const widget = await screen.findByRole('status', { name: 'export' });
    fireEvent.click(within(widget).getByRole('button', { name: 'close the export' }));
    await expectGoneSaid();
  });
});

describe('the timer that looks at the export', () => {
  it('reads in the background, so an open console does not keep its session awake', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = mockFetch(pageRoutes(recorded(), null));
      renderPage();
      await screen.findByRole('button', { name: 'Download' });
      const exportReads = () =>
        fetchMock.mock.calls
          .filter(([input, init]) => String(input) === '/api/export' && (init?.method ?? 'GET') === 'GET')
          .map(([, init]) => (init?.headers ?? {}) as Record<string, string>);

      // The first look comes with the operator opening the console, so it is theirs.
      expect(exportReads()[0]?.[BACKGROUND_READ_HEADER]).toBeUndefined();
      const before = exportReads().length;
      await vi.advanceTimersByTimeAsync(EXPORT_POLL_IDLE_MS + 100);
      const timed = exportReads().slice(before);
      expect(timed.length).toBeGreaterThan(0);
      for (const headers of timed) expect(headers[BACKGROUND_READ_HEADER]).toBe(BACKGROUND_READ_VALUE);
    } finally {
      vi.useRealTimers();
    }
  });
});
