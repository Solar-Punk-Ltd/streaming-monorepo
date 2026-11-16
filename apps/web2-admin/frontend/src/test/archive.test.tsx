import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_READ_HEADER,
  BACKGROUND_READ_VALUE,
  type ArchiveBuyTerms,
  type ArchiveJobItem,
  type ArchiveJobSummary,
  type ArchiveOptionsResponse,
  type ArchiveQuality,
  type ArchiveStamp,
  type ExportSummary,
  type Stream,
} from '@streaming-monorepo/web2-admin-common';

import type { BuyStampDialogProps } from '../components/archive/archiveSeams';
import { ArchivePanel, CANCEL_ARCHIVE_PROMPT } from '../components/archive/ArchivePanel';
import { ARCHIVE_POLL_IDLE_MS, decisionKey, useArchive } from '../components/archive/ArchiveProvider';
import { archiveActionLabel, estimateLine, estimateOf, formatXbzzRange } from '../components/archive/archiveJobText';
import { ExportPanel } from '../components/export/ExportPanel';
import { JobProviders, JobWidgets } from '../components/Jobs';
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

const { CHOICE } = vi.hoisted(() => ({
  CHOICE: { depth: 22, days: 30, label: 'Keynotes', costPlur: '100663296000000000' },
}));

// The buy dialog is a part of its own, with its own tests. Here it stands as a dialog that confirms one choice and
// shows what the API refused it with.
vi.mock('../components/archive/BuyStampDialog', async () => {
  const { Dialog } = await import('@mui/material');
  return {
    BuyStampDialog: ({ open, chunkCount, refusal, onConfirm, onClose }: BuyStampDialogProps) => (
      <Dialog open={open} onClose={onClose} aria-labelledby="buy-double-title">
        <h2 id="buy-double-title">buy a new archive stamp</h2>
        <p>Sized for {chunkCount} chunks</p>
        {refusal ? <p>{refusal}</p> : null}
        <button type="button" onClick={() => onConfirm(CHOICE)}>
          Confirm the stamp
        </button>
      </Dialog>
    ),
  };
});

const ID = '7d3c0e5a-2a8b-4f61-9c1e-3b2a1f0e9d8c';
const JOB_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const EXPORT_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const TALKS = 'a1'.repeat(32);
const SPRING = 'b2'.repeat(32);
const AUTUMN = 'c3'.repeat(32);

const TERMS: ArchiveBuyTerms = {
  postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
  walletXbzzPlur: '500000000000000000',
  walletXdaiWei: '1000000000000000000',
  defaultDays: 30,
  minimumDays: 2,
};

function makeQuality(overrides: Partial<ArchiveQuality> = {}): ArchiveQuality {
  return {
    rendition: '1080p',
    label: '1080p',
    width: 1920,
    height: 1080,
    durationSeconds: 3600,
    state: 'none',
    batchId: null,
    batchLabel: null,
    chunks: null,
    bytes: null,
    parityMissing: 0,
    completedAt: null,
    completedBy: null,
    estimatedChunks: 544_000,
    estimatedBytes: 2_200_000_000,
    estimatedBzzLowPlur: '4200000000000000',
    estimatedBzzHighPlur: '6300000000000000',
    estimatedSeconds: 3400,
    unavailable: null,
    ...overrides,
  };
}

function q720(overrides: Partial<ArchiveQuality> = {}): ArchiveQuality {
  return makeQuality({
    rendition: '720p',
    label: '720p',
    width: 1280,
    height: 720,
    estimatedChunks: 300_000,
    estimatedBytes: 1_200_000_000,
    estimatedBzzLowPlur: '2300000000000000',
    estimatedBzzHighPlur: '3500000000000000',
    estimatedSeconds: 1900,
    ...overrides,
  });
}

function makeStamp(overrides: Partial<ArchiveStamp> = {}): ArchiveStamp {
  return {
    batchId: TALKS,
    label: 'Talks',
    nodeId: 'catalogue',
    nodeLabel: 'Catalogue node',
    depth: 22,
    immutable: true,
    state: 'active',
    ttlSeconds: 200 * 86_400,
    fillRatio: 0.3,
    writable: true,
    designatedAt: '2026-11-01T10:00:00.000Z',
    effectiveChunks: 1_887_207,
    chunksStamped: 600_000,
    roomChunks: 1_287_207,
    qualitiesArchived: 2,
    expiresSoon: false,
    ...overrides,
  };
}

/** "Spring", nearly full: room for 10,000 chunks, which holds no quality of the recording. */
function springStamp(): ArchiveStamp {
  return makeStamp({ batchId: SPRING, label: 'Spring', depth: 20, roomChunks: 10_000, ttlSeconds: 20 * 86_400 });
}

function makeOptions(overrides: Partial<ArchiveOptionsResponse> = {}): ArchiveOptionsResponse {
  return {
    streamId: ID,
    title: 'Opening keynote',
    date: '2026-11-05',
    qualities: [makeQuality(), q720()],
    stamps: [makeStamp(), springStamp()],
    buy: TERMS,
    chequebookAvailablePlur: null,
    summary: { state: 'none', archived: [], archivedOnly: false },
    canListArchivedOnly: false,
    archivedOnlyHint: null,
    refusal: null,
    current: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ArchiveJobItem> = {}): ArchiveJobItem {
  return {
    rendition: '1080p',
    label: '1080p',
    state: 'copying',
    result: null,
    segmentsTotal: 1800,
    segmentsDone: 450,
    chunksTotal: 544_000,
    chunksCopied: 136_000,
    chunksRebuilt: 0,
    parityMissing: 0,
    chunksSynced: 120_000,
    postsMade: 136_000,
    bytesCopied: 557_000_000,
    ...overrides,
  };
}

function makeJob(overrides: Partial<ArchiveJobSummary> = {}): ArchiveJobSummary {
  return {
    id: JOB_ID,
    streamId: ID,
    streamTitle: 'Opening keynote',
    state: 'copying',
    pauseReason: null,
    pauseMessage: null,
    pausedAt: null,
    holdsPlace: true,
    target: { kind: 'stamp', batchId: TALKS, label: 'Talks' },
    proposal: null,
    items: [makeItem()],
    chunksTotal: 544_000,
    chunksCopied: 136_000,
    bytesCopied: 557_000_000,
    chunksPerSecond: 160,
    secondsLeft: 2550,
    bzzEstimateLowPlur: '4200000000000000',
    bzzEstimateHighPlur: '6300000000000000',
    chequebookAvailablePlur: '20000000000000000',
    bzzSpentPlur: null,
    startedBy: 'other-operator',
    startedByYou: false,
    startedAt: '2026-11-10T10:00:00.000Z',
    finishedAt: null,
    dismissed: false,
    actions: ['pause', 'cancel'],
    ...overrides,
  };
}

/** Paused because "Talks" lacks room, started by the user who asks. */
function batchPause(overrides: Partial<ArchiveJobSummary> = {}): ArchiveJobSummary {
  return makeJob({
    state: 'paused',
    pauseReason: 'batch',
    pauseMessage: 'The archive stamp “Talks” lacks room for what is left.',
    pausedAt: '2026-11-10T10:30:00.000Z',
    startedByYou: true,
    startedBy: 'test-operator',
    actions: ['resume', 'use_stamp', 'buy_new', 'cancel'],
    ...overrides,
  });
}

function makeExport(overrides: Partial<ExportSummary> = {}): ExportSummary {
  return {
    id: EXPORT_ID,
    streamId: ID,
    streamTitle: 'Opening keynote',
    rendition: '720p',
    quality: '720p',
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

/** The archive's and the export's own routes: the archive on the server, the export, and the stream's options. */
function jobRoutes(
  archive: ArchiveJobSummary | null,
  options: ArchiveOptionsResponse = makeOptions(),
  exported: ExportSummary | null = null,
): MockRoute[] {
  return [
    { path: '/api/archive', respond: () => jsonOk({ archive }) },
    { path: '/api/export', respond: () => jsonOk({ export: exported }) },
    { path: `/api/streams/${ID}/archive`, respond: () => jsonOk(options) },
  ];
}

/** Opens the archive panel as a page does: the stream's page, the Archive page or a finished export. */
function Opener({ streamId, preselect }: { streamId: string | null; preselect?: string[] }) {
  const { openPanel } = useArchive();
  return (
    <button type="button" onClick={() => openPanel(streamId, preselect)}>
      Open the archive panel
    </button>
  );
}

/** The panels and the widgets as the shell holds them, with a button that opens the archive panel. */
function renderPanels(opener: { streamId: string | null; preselect?: string[] } = { streamId: ID }) {
  return renderWithProviders(
    <JobProviders>
      <Opener {...opener} />
      <JobWidgets />
      <ExportPanel />
      <ArchivePanel />
    </JobProviders>,
  );
}

function recorded(overrides: Partial<Stream> = {}): Stream {
  return makeStream({
    id: ID,
    title: 'Opening keynote',
    status: 'vod',
    manifestIndex: 12,
    durationSeconds: 3600,
    ...overrides,
  });
}

/** The stream's page as the shell shows it, with the widgets and both panels. */
function renderPage(stream: Stream, extra: MockRoute[]) {
  const fetchMock = mockFetch([
    ...extra,
    { path: `/api/streams/${ID}`, respond: () => jsonOk(stream) },
    { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest()) },
    {
      path: '/api/config',
      respond: () => jsonOk({ feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff' }, viewerBaseUrl: null }),
    },
  ]);
  renderWithProviders(
    <JobProviders>
      <Routes>
        <Route
          path="/streams/:id"
          element={
            <>
              <StreamDetailsPage />
              <JobWidgets />
              <ExportPanel />
              <ArchivePanel />
            </>
          }
        />
      </Routes>
    </JobProviders>,
    { route: `/streams/${ID}` },
  );
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof mockFetch>, method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input) === path && init?.method === method);
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

describe('the archive in words', () => {
  it('gives a cost range in xBZZ, one figure when both ends round alike, and an estimate in one line', () => {
    expect(formatXbzzRange('4200000000000000', '6300000000000000')).toBe('0.42 to 0.63 xBZZ');
    expect(formatXbzzRange('4200000000000000', '4210000000000000')).toBe('0.42 xBZZ');
    expect(formatXbzzRange(null, '6300000000000000')).toBeNull();
    expect(estimateLine(estimateOf([makeQuality()]))).toBe(
      "About 2.2 GB, 544,000 chunks, 0.42 to 0.63 xBZZ from the catalogue node's chequebook, about 56 min 40 s",
    );
    expect(estimateLine(estimateOf([makeQuality({ estimatedBytes: null, estimatedSeconds: null })]))).toBe(
      "544,000 chunks, 0.42 to 0.63 xBZZ from the catalogue node's chequebook",
    );
  });

  it('names Resume after the reason the archive paused for', () => {
    expect(archiveActionLabel('resume', batchPause())).toBe('Try again after a dilution');
    expect(archiveActionLabel('resume', batchPause({ pauseReason: 'funds' }))).toBe('Try again after funding it');
    expect(archiveActionLabel('resume', batchPause({ pauseReason: 'unreadable' }))).toBe('Try again');
    expect(archiveActionLabel('resume', batchPause({ pauseReason: 'user' }))).toBe('Resume');
  });

  it('brings the panel to front for the user who started the archive, once a pause or a purchase asks them', () => {
    expect(decisionKey(batchPause())).toBe(`${JOB_ID}@paused@2026-11-10T10:30:00.000Z`);
    expect(decisionKey(batchPause({ startedByYou: false }))).toBeNull();
    expect(decisionKey(batchPause({ pauseReason: 'user' }))).toBeNull();
    expect(decisionKey(makeJob({ state: 'awaiting_purchase', startedByYou: true }))).toBe(
      `${JOB_ID}@awaiting_purchase`,
    );
    expect(decisionKey(makeJob({ startedByYou: true }))).toBeNull();
  });
});

describe("the stream page's archive card", () => {
  it('shows each quality with its state, the stamps that run out soon, and the switch where it is offered', async () => {
    const hint = 'The stage batch that holds 720p has expired, so 720p no longer plays.';
    const archived = makeOptions({
      qualities: [
        makeQuality({
          state: 'complete',
          batchId: TALKS,
          batchLabel: 'Talks',
          chunks: 540_000,
          bytes: 2_200_000_000,
          completedAt: '2026-11-12T09:51:10.000Z',
          completedBy: 'alice',
        }),
        q720(),
      ],
      stamps: [makeStamp({ expiresSoon: true, ttlSeconds: 20 * 86_400 })],
      summary: { state: 'complete', archived: ['1080p'], archivedOnly: false },
      canListArchivedOnly: true,
      archivedOnlyHint: hint,
    });
    const fetchMock = renderPage(recorded({ archive: archived.summary }), [
      ...jobRoutes(null, archived),
      {
        path: `/api/streams/${ID}/archive/listing`,
        method: 'PUT',
        respond: () => jsonOk({ ...archived, summary: { ...archived.summary, archivedOnly: true } }),
      },
    ]);

    const card = await screen.findByRole('region', { name: 'archive' });
    expect(await within(card).findByText('Archived')).toBeInTheDocument();
    expect(
      within(card).getByText('2.2 GB on “Talks”, completed 2026-11-12 09:51:10 UTC by alice.'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Not archived')).toBeInTheDocument();
    expect(within(card).getByText(/“Talks” has 20 days left/)).toBeInTheDocument();
    expect(within(card).getByText(hint)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Archive more qualities' })).toBeInTheDocument();

    const toggle = within(card).getByRole('switch', { name: 'List only archived qualities' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(bodyOf(fetchMock, 'PUT', `/api/streams/${ID}/archive/listing`)).toEqual({ archivedOnly: true });
    // Once it is on, the hint to turn it on is said no more.
    expect(within(card).queryByText(hint)).not.toBeInTheDocument();
  });

  it('is not on the page of a stream that holds no recording and has no archive', async () => {
    renderPage(makeStream({ id: ID, status: 'live', manifestIndex: null }), jobRoutes(null));
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.queryByRole('region', { name: 'archive' })).not.toBeInTheDocument();
  });

  it('opens the archive panel on the stream with its start action', async () => {
    renderPage(recorded(), jobRoutes(null));
    const card = await screen.findByRole('region', { name: 'archive' });
    fireEvent.click(await within(card).findByRole('button', { name: 'Archive this recording' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });
    expect(await within(panel).findByRole('checkbox', { name: /1080p/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /720p/ })).not.toBeChecked();
  });
});

describe('the archive panel', () => {
  it('offers each quality with its estimate, keeps a stamp without room out, and starts onto the stamp chosen', async () => {
    const fetchMock = mockFetch([
      ...jobRoutes(null),
      {
        path: `/api/streams/${ID}/archive`,
        method: 'POST',
        respond: () => jsonOk({ archive: makeJob({ state: 'measuring', startedByYou: true }) }, 202),
      },
    ]);
    renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });

    expect(
      await within(panel).findByText(
        "About 2.2 GB, 544,000 chunks, 0.42 to 0.63 xBZZ from the catalogue node's chequebook, about 56 min 40 s",
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /Talks/ })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: /Spring/ })).toBeDisabled();
    expect(within(panel).getByText(/Not enough room for 544,000 chunks/)).toBeInTheDocument();

    // Both qualities together, still on "Talks".
    fireEvent.click(within(panel).getByRole('checkbox', { name: /720p/ }));
    expect(within(panel).getByText(/^In all: About 3\.4 GB, 844,000 chunks/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Start archive' }));

    await waitFor(() =>
      expect(bodyOf(fetchMock, 'POST', `/api/streams/${ID}/archive`)).toEqual({
        renditions: ['1080p', '720p'],
        target: { batchId: TALKS },
      }),
    );
    expect(
      await within(panel).findByText("Measuring the recording: each segment's size is read from Swarm."),
    ).toBeInTheDocument();
  });

  it('ticks the qualities it was opened with, and starts onto a new stamp when that is the choice', async () => {
    const fetchMock = mockFetch([
      ...jobRoutes(null),
      {
        path: `/api/streams/${ID}/archive`,
        method: 'POST',
        respond: () => jsonOk({ archive: makeJob({ state: 'measuring', startedByYou: true }) }, 202),
      },
    ]);
    renderPanels({ streamId: ID, preselect: ['720p'] });
    fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });

    expect(await within(panel).findByRole('checkbox', { name: /720p/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /1080p/ })).not.toBeChecked();
    fireEvent.click(within(panel).getByRole('radio', { name: /Buy a new archive stamp/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Start archive' }));

    await waitFor(() =>
      expect(bodyOf(fetchMock, 'POST', `/api/streams/${ID}/archive`)).toEqual({
        renditions: ['720p'],
        target: { buyNew: true },
      }),
    );
  });

  it('warns before a start when the chequebook can pay less than the picked qualities may cost, and still starts', async () => {
    mockFetch([
      ...jobRoutes(null, makeOptions({ chequebookAvailablePlur: '5000000000000000' })),
      {
        path: `/api/streams/${ID}/archive`,
        method: 'POST',
        respond: () => jsonOk({ archive: makeJob({ state: 'measuring', startedByYou: true }) }, 202),
      },
    ]);
    renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });

    expect(
      await within(panel).findByText(
        /The catalogue node's chequebook can pay 0\.50 xBZZ now, less than this archive may cost/,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/the archive would then pause for funds/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Start archive' })).toBeEnabled();
  });

  for (const [held, plur] of [
    ['holds enough', '10000000000000000'],
    ['was not read', null],
  ] as const) {
    it(`says nothing of the chequebook before a start when it ${held}`, async () => {
      mockFetch(jobRoutes(null, makeOptions({ chequebookAvailablePlur: plur })));
      renderPanels();
      fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
      const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });
      expect(await within(panel).findByText(/^About 2\.2 GB/)).toBeInTheDocument();
      expect(within(panel).queryByText(/less than this archive may cost/)).not.toBeInTheDocument();
    });
  }

  it('says why no archive can start now, and Start stays disabled', async () => {
    const refusal = 'The export of "Opening keynote" (720p) is under way. One job runs at a time.';
    mockFetch(jobRoutes(null, makeOptions({ refusal: { problem: 'busy', message: refusal } })));
    renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });

    expect(await within(panel).findByText(refusal)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Start archive' })).toBeDisabled();
  });

  it('comes to front for the user who started an archive that paused on its stamp, with every choice', async () => {
    const options = makeOptions({
      stamps: [makeStamp(), makeStamp({ batchId: AUTUMN, label: 'Autumn', roomChunks: 1_000_000 })],
    });
    const fetchMock = mockFetch([
      ...jobRoutes(batchPause(), options),
      {
        path: `/api/archive/${JOB_ID}/actions`,
        method: 'POST',
        respond: () => jsonOk({ archive: makeJob({ target: { kind: 'stamp', batchId: AUTUMN, label: 'Autumn' } }) }),
      },
    ]);
    renderPanels({ streamId: null });

    const panel = await screen.findByRole('dialog', { name: 'Archive of “Opening keynote”' });
    expect(within(panel).getByText('The archive stamp “Talks” lacks room for what is left.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Try again after a dilution' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Buy a new archive stamp' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Cancel archive' })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Use another stamp' }));
    const picker = await screen.findByRole('dialog', { name: 'Use another archive stamp' });
    // The stamp in use is left out, and the first other one that holds what is left is chosen.
    expect(await within(picker).findByRole('radio', { name: /Autumn/ })).toBeChecked();
    expect(within(picker).queryByRole('radio', { name: /Talks/ })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('button', { name: 'Use this stamp' }));

    await waitFor(() =>
      expect(bodyOf(fetchMock, 'POST', `/api/archive/${JOB_ID}/actions`)).toEqual({
        action: 'use_stamp',
        batchId: AUTUMN,
      }),
    );
  });

  it('leaves the panel closed for everyone else, whose widget says the archive needs a decision', async () => {
    mockFetch(jobRoutes(batchPause({ startedByYou: false, startedBy: 'other-operator' })));
    renderPanels({ streamId: null });

    const widget = await screen.findByRole('status', { name: 'archive' });
    expect(within(widget).getByText('Paused: needs a decision')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(within(widget).getByRole('button', { name: 'open the archive' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive of “Opening keynote”' });
    expect(within(panel).getByText(/started by other-operator/)).toBeInTheDocument();
  });

  it('opens the buy dialog on the stamp the archive proposes, confirms it, and says why when the price moved', async () => {
    const moved =
      'The price of postage moved, and this stamp now costs 103079215104000000 PLUR. Confirm it again at that cost.';
    let job: ArchiveJobSummary = makeJob({
      state: 'awaiting_purchase',
      holdsPlace: false,
      startedByYou: true,
      startedBy: 'test-operator',
      target: { kind: 'purchase', purchase: null },
      proposal: {
        chunkCount: 544_000,
        depth: 22,
        days: 30,
        costPlur: '100663296000000000',
        shortfallPlur: null,
        terms: TERMS,
      },
      items: [makeItem({ state: 'waiting', chunksCopied: 0 })],
      actions: ['use_stamp', 'cancel'],
    });
    let confirms = 0;
    const fetchMock = mockFetch([
      { path: '/api/archive', respond: () => jsonOk({ archive: job }) },
      { path: '/api/export', respond: () => jsonOk({ export: null }) },
      {
        path: '/api/archive/current/confirm-purchase',
        method: 'POST',
        respond: () => {
          confirms += 1;
          if (confirms === 1) {
            return jsonError(409, { error: 'archive_refused', problem: 'price_moved', message: moved });
          }
          job = makeJob({
            state: 'buying',
            startedByYou: true,
            target: {
              kind: 'purchase',
              purchase: {
                id: 'p1',
                depth: 22,
                days: 30,
                amountPerChunkPlur: '24000',
                costPlur: CHOICE.costPlur,
                label: 'Keynotes',
                state: 'buying',
                batchId: null,
                error: null,
                startedBy: 'test-operator',
                startedAt: '2026-11-10T10:40:00.000Z',
              },
            },
            actions: ['pause', 'cancel'],
          });
          return jsonOk({ archive: job });
        },
      },
    ]);
    renderPanels({ streamId: null });

    const buy = await screen.findByRole('dialog', { name: 'buy a new archive stamp' });
    expect(within(buy).getByText('Sized for 544000 chunks')).toBeInTheDocument();
    fireEvent.click(within(buy).getByRole('button', { name: 'Confirm the stamp' }));
    expect(await within(buy).findByText(moved)).toBeInTheDocument();
    expect(bodyOf(fetchMock, 'POST', '/api/archive/current/confirm-purchase')).toEqual(CHOICE);

    fireEvent.click(within(buy).getByRole('button', { name: 'Confirm the stamp' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'buy a new archive stamp' })).not.toBeInTheDocument(),
    );
    const panel = screen.getByRole('dialog', { name: 'Archive of “Opening keynote”' });
    expect(
      within(panel).getByText("Buying the archive stamp: the catalogue node's transaction is not mined yet."),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/The new stamp: depth 22 for 30 days/)).toBeInTheDocument();
  });

  it('asks before cancelling, and Keep it sends nothing', async () => {
    const fetchMock = mockFetch([
      ...jobRoutes(makeJob()),
      { path: `/api/archive/${JOB_ID}/actions`, method: 'POST', respond: () => jsonOk({ archive: null }) },
    ]);
    renderPanels({ streamId: null });
    fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive of “Opening keynote”' });
    expect(within(panel).getByText(/Copying to Swarm: 136,000 of 544,000 chunks/)).toBeInTheDocument();
    expect(within(panel).getByText('160 chunks a second, about 42 min 30 s left.')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel archive' }));
    const ask = await screen.findByRole('dialog', { name: 'Cancel the archive?' });
    expect(within(ask).getByText(CANCEL_ARCHIVE_PROMPT)).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel the archive?' })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel archive' }));
    const again = await screen.findByRole('dialog', { name: 'Cancel the archive?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel archive' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, 'POST', `/api/archive/${JOB_ID}/actions`)).toEqual({ action: 'cancel' }),
    );
  });

  it('warns when the chequebook holds less than the copy may cost', async () => {
    mockFetch(jobRoutes(makeJob({ chequebookAvailablePlur: '5000000000000000' })));
    renderPanels({ streamId: null });
    fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
    const panel = await screen.findByRole('dialog', { name: 'Archive of “Opening keynote”' });
    expect(
      within(panel).getByText(
        "Expected to cost the catalogue node's chequebook 0.42 to 0.63 xBZZ. It can pay 0.50 xBZZ now.",
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/The chequebook holds less than the copy may cost/)).toBeInTheDocument();
  });
});

describe('the job widgets', () => {
  it('show the running export, and a paused archive under it', async () => {
    mockFetch(
      jobRoutes(
        makeJob({ state: 'paused', pauseReason: 'user', pauseMessage: 'Paused by alice.', holdsPlace: false }),
        makeOptions(),
        makeExport(),
      ),
    );
    renderPanels();

    const exported = await screen.findByRole('status', { name: 'export' });
    const archive = await screen.findByRole('status', { name: 'archive' });
    expect(within(archive).getByText('Opening keynote · 1080p')).toBeInTheDocument();
    expect(within(archive).getByText('Paused')).toBeInTheDocument();
    expect(exported.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('show a running archive above a kept export file', async () => {
    mockFetch(
      jobRoutes(
        makeJob(),
        makeOptions(),
        makeExport({
          state: 'done',
          fileName: 'opening-keynote-720p.mp4',
          sizeBytes: 1_000_000_000,
          actions: ['dismiss', 'clear'],
        }),
      ),
    );
    renderPanels();

    const archive = await screen.findByRole('status', { name: 'archive' });
    const exported = await screen.findByRole('status', { name: 'export' });
    expect(within(archive).getByText('25% copied')).toBeInTheDocument();
    expect(archive.compareDocumentPosition(exported) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('close a finished archive for the user who asks', async () => {
    const done = makeJob({
      state: 'done',
      holdsPlace: false,
      items: [makeItem({ state: 'done', result: 'reduced', parityMissing: 12, chunksCopied: 544_000 })],
      finishedAt: '2026-11-10T11:04:14.000Z',
      bzzSpentPlur: '5100000000000000',
      actions: ['dismiss'],
    });
    const fetchMock = mockFetch([
      ...jobRoutes(done),
      {
        path: `/api/archive/${JOB_ID}/actions`,
        method: 'POST',
        respond: () => jsonOk({ archive: { ...done, dismissed: true, actions: [] } }),
      },
    ]);
    renderPanels();

    const widget = await screen.findByRole('status', { name: 'archive' });
    expect(within(widget).getByText('Archived, reduced protection')).toBeInTheDocument();
    fireEvent.click(within(widget).getByRole('button', { name: 'close the archive' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'archive' })).not.toBeInTheDocument());
    expect(bodyOf(fetchMock, 'POST', `/api/archive/${JOB_ID}/actions`)).toEqual({ action: 'dismiss' });
  });
});

describe('archiving a quality from a finished export', () => {
  it('opens the archive panel on that stream with the exported quality ticked', async () => {
    const kept = makeExport({
      state: 'done',
      fileName: 'opening-keynote-2026-11-05-720p.mp4',
      sizeBytes: 1_000_000_000,
      finishedAt: '2026-11-10T10:20:00.000Z',
      actions: ['dismiss', 'clear'],
    });
    mockFetch(jobRoutes(null, makeOptions(), kept));
    renderPanels();

    fireEvent.click(await screen.findByRole('button', { name: 'open the export' }));
    const download = await screen.findByRole('dialog', { name: '“Opening keynote”' });
    fireEvent.click(within(download).getByRole('button', { name: 'Archive this quality' }));

    const panel = await screen.findByRole('dialog', { name: 'Archive “Opening keynote”' });
    expect(await within(panel).findByRole('checkbox', { name: /720p/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /1080p/ })).not.toBeChecked();
  });
});

describe('the timer that looks at the archive', () => {
  it('reads in the background, so an open console does not keep its session awake', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = mockFetch(jobRoutes(null));
      renderPanels();
      const archiveReads = () =>
        fetchMock.mock.calls
          .filter(([input, init]) => String(input) === '/api/archive' && (init?.method ?? 'GET') === 'GET')
          .map(([, init]) => (init?.headers ?? {}) as Record<string, string>);
      await waitFor(() => expect(archiveReads().length).toBeGreaterThan(0));

      // The first look comes with the operator opening the console, so it is theirs.
      expect(archiveReads()[0]?.[BACKGROUND_READ_HEADER]).toBeUndefined();
      const before = archiveReads().length;
      await vi.advanceTimersByTimeAsync(ARCHIVE_POLL_IDLE_MS + 100);
      const timed = archiveReads().slice(before);
      expect(timed.length).toBeGreaterThan(0);
      for (const headers of timed) expect(headers[BACKGROUND_READ_HEADER]).toBe(BACKGROUND_READ_VALUE);
    } finally {
      vi.useRealTimers();
    }
  });
});
