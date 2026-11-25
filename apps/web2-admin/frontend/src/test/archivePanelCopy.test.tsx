import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  ArchiveBuyTerms,
  ArchiveCopy,
  ArchiveJobSummary,
  ArchiveOptionsResponse,
  ArchiveQuality,
  ArchiveStamp,
} from '@streaming-monorepo/web2-admin-common';

import { ALL_ARCHIVED_TEXT, ArchivePanel, NOTHING_TO_COPY_TEXT } from '../components/archive/ArchivePanel';
import { useArchive } from '../components/archive/ArchiveProvider';
import type { ArchivePanelMode } from '../components/archive/archiveSeams';
import { JobProviders } from '../components/Jobs';
import { jsonOk, mockFetch, renderWithProviders, type Route as MockRoute } from './helpers';

// The archive panel's two modes: a quality's first archive, which every opener there was before keeps, and a further
// copy of the archived qualities onto another stamp, which the Archive page's "Copy onto another stamp" opens.

const ID = '7d3c0e5a-2a8b-4f61-9c1e-3b2a1f0e9d8c';
const JOB_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const TALKS = 'a1'.repeat(32);
const SPRING = 'b2'.repeat(32);
/** A stamp with no label, which the panel names by its short id. */
const UNNAMED = 'c3'.repeat(32);
const UNNAMED_SHORT = `${'c3'.repeat(4)}…${'c3'.repeat(3)}`;
const ARCHIVED_ALREADY = 'This quality is archived at its recording already.';

const TERMS: ArchiveBuyTerms = {
  postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
  walletXbzzPlur: '500000000000000000',
  walletXdaiWei: '1000000000000000000',
  defaultDays: 30,
  minimumDays: 2,
};

function makeCopy(overrides: Partial<ArchiveCopy> = {}): ArchiveCopy {
  return {
    batchId: TALKS,
    batchLabel: 'Talks',
    state: 'complete',
    chunks: 540_000,
    bytes: 2_200_000_000,
    parityMissing: 0,
    completedAt: '2026-11-12T09:51:10.000Z',
    completedBy: 'alice',
    batchTtlSeconds: 200 * 86_400,
    ...overrides,
  };
}

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
    copies: [],
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

function q480(overrides: Partial<ArchiveQuality> = {}): ArchiveQuality {
  return makeQuality({
    rendition: '480p',
    label: '480p',
    width: 854,
    height: 480,
    estimatedChunks: 150_000,
    estimatedBytes: 600_000_000,
    estimatedBzzLowPlur: '1200000000000000',
    estimatedBzzHighPlur: '1700000000000000',
    estimatedSeconds: 950,
    ...overrides,
  });
}

/** A quality archived by its copies, best first, whose own fields are the first copy's, as the API answers it. */
function archived(quality: ArchiveQuality, copies: ArchiveCopy[]): ArchiveQuality {
  const [best] = copies;
  return {
    ...quality,
    state: best.state,
    batchId: best.batchId,
    batchLabel: best.batchLabel,
    chunks: best.chunks,
    bytes: best.bytes,
    completedAt: best.completedAt,
    completedBy: best.completedBy,
    copies,
    unavailable: ARCHIVED_ALREADY,
  };
}

/** 1080p, archived on "Talks": 540,000 chunks. */
function on1080(): ArchiveQuality {
  return archived(makeQuality(), [makeCopy()]);
}

/** 720p, archived on "Spring": 300,000 chunks. */
function on720(): ArchiveQuality {
  return archived(q720(), [makeCopy({ batchId: SPRING, batchLabel: 'Spring', chunks: 300_000, bytes: 1_200_000_000 })]);
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

/** "Talks", "Spring" and a stamp with no label, each with room for the recording. */
function stamps(): ArchiveStamp[] {
  return [
    makeStamp(),
    makeStamp({ batchId: SPRING, label: 'Spring', roomChunks: 1_000_000 }),
    makeStamp({ batchId: UNNAMED, label: null, roomChunks: 1_000_000 }),
  ];
}

/** A recording with 1080p on "Talks", 720p on "Spring", and 480p not archived. */
function makeOptions(overrides: Partial<ArchiveOptionsResponse> = {}): ArchiveOptionsResponse {
  return {
    streamId: ID,
    title: 'Opening keynote',
    date: '2026-11-05',
    qualities: [on1080(), on720(), q480()],
    stamps: stamps(),
    holdingStamps: [],
    buy: TERMS,
    chequebookAvailablePlur: null,
    summary: { state: 'complete', archived: ['1080p', '720p'], archivedOnly: false },
    thumbnail: { state: 'none', batchIds: [] },
    canListArchivedOnly: true,
    archivedOnlyHint: null,
    refusal: null,
    current: null,
    ...overrides,
  };
}

/** A further copy of 1080p onto the stamp with no label, paused there for room, started by the user who asks. */
function pausedCopy(): ArchiveJobSummary {
  return {
    id: JOB_ID,
    streamId: ID,
    streamTitle: 'Opening keynote',
    state: 'paused',
    pauseReason: 'batch',
    pauseMessage: 'The archive stamp lacks room for what is left.',
    pausedAt: '2026-11-10T10:30:00.000Z',
    holdsPlace: true,
    target: { kind: 'stamp', batchId: UNNAMED, label: null },
    proposal: null,
    items: [
      {
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
      },
    ],
    chunksTotal: 544_000,
    chunksCopied: 136_000,
    bytesCopied: 557_000_000,
    chunksPerSecond: null,
    secondsLeft: null,
    bzzEstimateLowPlur: null,
    bzzEstimateHighPlur: null,
    chequebookAvailablePlur: null,
    bzzSpentPlur: null,
    startedBy: 'test-operator',
    startedByYou: true,
    startedAt: '2026-11-10T10:00:00.000Z',
    finishedAt: null,
    dismissed: false,
    actions: ['resume', 'use_stamp', 'buy_new', 'cancel'],
  };
}

/** The archive's and the export's own routes, the stream's options, and any other the test names first. */
function routes(
  options: ArchiveOptionsResponse,
  archive: ArchiveJobSummary | null = null,
  extra: MockRoute[] = [],
): MockRoute[] {
  return [
    ...extra,
    { path: '/api/archive', respond: () => jsonOk({ archive }) },
    { path: '/api/export', respond: () => jsonOk({ export: null }) },
    { path: `/api/streams/${ID}/archive`, respond: () => jsonOk(options) },
  ];
}

/** Opens the archive panel on the stream as a page does, with the qualities and the mode it is given. */
function Opener({ preselect, mode }: { preselect?: string[]; mode?: ArchivePanelMode }) {
  const { openPanel } = useArchive();
  return (
    <button type="button" onClick={() => openPanel(ID, preselect, mode)}>
      Open the archive panel
    </button>
  );
}

/** Renders the panel with its opener, and opens it. */
function openPanelWith(
  options: ArchiveOptionsResponse,
  opener: { preselect?: string[]; mode?: ArchivePanelMode },
  extra: MockRoute[] = [],
) {
  const fetchMock = mockFetch(routes(options, null, extra));
  renderWithProviders(
    <JobProviders>
      <Opener {...opener} />
      <ArchivePanel />
    </JobProviders>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open the archive panel' }));
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof mockFetch>, method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input) === path && init?.method === method);
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

const COPY_TITLE = 'Copy “Opening keynote” onto another stamp';
const ARCHIVE_TITLE = 'Archive “Opening keynote”';

describe("the archive panel's opener", () => {
  it('opens the panel for a first archive unless it is told to open it for a further copy', () => {
    mockFetch(routes(makeOptions()));
    function Probe() {
      const { panel, openPanel } = useArchive();
      return (
        <>
          <p>{panel.open ? `open for ${panel.mode}: ${panel.preselect.join(', ')}` : 'closed'}</p>
          <button type="button" onClick={() => openPanel(ID, ['1080p'])}>
            archive
          </button>
          <button type="button" onClick={() => openPanel(ID, ['1080p', '720p'], 'copy')}>
            copy
          </button>
        </>
      );
    }
    renderWithProviders(
      <JobProviders>
        <Probe />
      </JobProviders>,
    );
    expect(screen.getByText('closed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    expect(screen.getByText('open for copy: 1080p, 720p')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'archive' }));
    expect(screen.getByText('open for archive: 1080p')).toBeInTheDocument();
  });
});

describe('the archive panel, opened for a further copy', () => {
  it('offers the archived qualities alone, every one ticked, each with the stamps it is on', async () => {
    openPanelWith(makeOptions(), { mode: 'copy' });
    const panel = await screen.findByRole('dialog', { name: COPY_TITLE });

    expect(await within(panel).findByRole('checkbox', { name: /1080p/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /720p/ })).toBeChecked();
    expect(within(panel).queryByRole('checkbox', { name: /480p/ })).not.toBeInTheDocument();
    expect(within(panel).getByText('On “Talks”: 2.2 GB, 540,000 chunks.')).toBeInTheDocument();
    expect(within(panel).getByText('On “Spring”: 1.2 GB, 300,000 chunks.')).toBeInTheDocument();
    expect(within(panel).queryByText(ARCHIVED_ALREADY)).not.toBeInTheDocument();
  });

  it('leaves out, with the reason, each stamp that holds an archived copy of a ticked quality, and starts onto another', async () => {
    const fetchMock = openPanelWith(makeOptions(), { mode: 'copy' }, [
      {
        path: `/api/streams/${ID}/archive`,
        method: 'POST',
        respond: () => jsonOk({ archive: { ...pausedCopy(), state: 'measuring', pauseReason: null } }, 202),
      },
    ]);
    const panel = await screen.findByRole('dialog', { name: COPY_TITLE });

    expect(await within(panel).findByRole('radio', { name: /Talks/ })).toBeDisabled();
    expect(
      within(panel).getByText(/1080p is archived on this stamp already\. Choose another stamp for a further copy\./),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /Spring/ })).toBeDisabled();
    expect(within(panel).getByText(/720p is archived on this stamp already\./)).toBeInTheDocument();
    // The first stamp that holds neither, and has the room, is chosen, and a new stamp is offered as ever.
    expect(within(panel).getByRole('radio', { name: new RegExp(UNNAMED_SHORT) })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: /Buy a new archive stamp/ })).toBeEnabled();

    fireEvent.click(within(panel).getByRole('button', { name: 'Start copy' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, 'POST', `/api/streams/${ID}/archive`)).toEqual({
        renditions: ['1080p', '720p'],
        target: { batchId: UNNAMED },
      }),
    );
    expect(
      await within(panel).findByText("Measuring the recording: each segment's size is read from Swarm."),
    ).toBeInTheDocument();
  });

  it('says before the start the room on the stamp chosen, the bandwidth, and that each copy stays until its stamp runs out', async () => {
    openPanelWith(makeOptions(), { mode: 'copy' });
    const panel = await screen.findByRole('dialog', { name: COPY_TITLE });
    const before = await within(panel).findByRole('region', { name: 'before the copy starts' });

    expect(
      within(before).getByText(`The copy takes room for 840,000 chunks on the stamp ${UNNAMED_SHORT}.`),
    ).toBeInTheDocument();
    expect(
      within(before).getByText(
        "Its bandwidth costs the catalogue node's chequebook 0.65 to 0.98 xBZZ, as a first copy's does.",
      ),
    ).toBeInTheDocument();
    expect(within(before).getByText('The copy on “Talks” stays until that stamp runs out.')).toBeInTheDocument();
    expect(within(before).getByText('The copy on “Spring” stays until that stamp runs out.')).toBeInTheDocument();

    // With 720p left out, "Spring" holds nothing the copy takes, and its copy is spoken of no more.
    fireEvent.click(within(panel).getByRole('checkbox', { name: /720p/ }));
    expect(within(panel).getByRole('radio', { name: /Spring/ })).toBeEnabled();
    expect(
      within(before).getByText(`The copy takes room for 540,000 chunks on the stamp ${UNNAMED_SHORT}.`),
    ).toBeInTheDocument();
    expect(
      within(before).getByText(
        "Its bandwidth costs the catalogue node's chequebook 0.42 to 0.63 xBZZ, as a first copy's does.",
      ),
    ).toBeInTheDocument();
    expect(within(before).queryByText(/The copy on “Spring”/)).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('radio', { name: /Spring/ }));
    expect(within(before).getByText('The copy takes room for 540,000 chunks on “Spring”.')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('radio', { name: /Buy a new archive stamp/ }));
    expect(
      within(before).getByText(
        'The copy takes room for 540,000 chunks on a new archive stamp, sized to it once the recording is measured.',
      ),
    ).toBeInTheDocument();
  });

  it('ticks the archived qualities it was opened with, and offers the stamp the others are on', async () => {
    openPanelWith(makeOptions(), { preselect: ['720p'], mode: 'copy' });
    const panel = await screen.findByRole('dialog', { name: COPY_TITLE });

    expect(await within(panel).findByRole('checkbox', { name: /720p/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /1080p/ })).not.toBeChecked();
    expect(within(panel).getByRole('radio', { name: /Talks/ })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: /Spring/ })).toBeDisabled();
  });

  it('names each stamp a quality is on, and says the copy on each stays', async () => {
    const twice = archived(q720(), [
      makeCopy({ batchId: SPRING, batchLabel: 'Spring', chunks: 300_000, bytes: 1_200_000_000 }),
      makeCopy({ chunks: 300_000, bytes: 1_200_000_000, batchTtlSeconds: 20 * 86_400 }),
    ]);
    openPanelWith(makeOptions({ qualities: [twice, q480()] }), { mode: 'copy' });
    const panel = await screen.findByRole('dialog', { name: COPY_TITLE });

    expect(await within(panel).findByText('On “Spring” and “Talks”: 1.2 GB, 300,000 chunks.')).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /Talks/ })).toBeDisabled();
    expect(within(panel).getByRole('radio', { name: /Spring/ })).toBeDisabled();
    const before = within(panel).getByRole('region', { name: 'before the copy starts' });
    expect(within(before).getByText('The copy on “Spring” stays until that stamp runs out.')).toBeInTheDocument();
    expect(within(before).getByText('The copy on “Talks” stays until that stamp runs out.')).toBeInTheDocument();
  });

  it('says so when no quality of the recording is archived, and starts nothing', async () => {
    openPanelWith(makeOptions({ qualities: [makeQuality(), q720()] }), { mode: 'copy' });
    const panel = await screen.findByRole('dialog', { name: COPY_TITLE });

    expect(await within(panel).findByText(NOTHING_TO_COPY_TEXT)).toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'before the copy starts' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Start copy' })).toBeDisabled();
  });
});

describe('the archive panel, opened for a first archive', () => {
  it('says a further copy starts from the Archive page when every quality that finished is archived', async () => {
    const unfinished = q480({ unavailable: 'This quality has not finished recording.' });
    openPanelWith(makeOptions({ qualities: [on1080(), on720(), unfinished] }), {});
    const panel = await screen.findByRole('dialog', { name: ARCHIVE_TITLE });

    expect(await within(panel).findByText(ALL_ARCHIVED_TEXT)).toBeInTheDocument();
    for (const name of [/1080p/, /720p/, /480p/]) {
      expect(within(panel).getByRole('checkbox', { name })).toBeDisabled();
    }
    expect(within(panel).getByRole('button', { name: 'Start archive' })).toBeDisabled();
    expect(within(panel).queryByRole('region', { name: 'before the copy starts' })).not.toBeInTheDocument();
  });

  it('says only why it is refused when the API refuses a start', async () => {
    const busy = 'The export of "Opening keynote" (720p) is under way. One job runs at a time.';
    const options = makeOptions({ qualities: [on1080(), on720()], refusal: { problem: 'busy', message: busy } });
    openPanelWith(options, {});
    const panel = await screen.findByRole('dialog', { name: ARCHIVE_TITLE });

    expect(await within(panel).findByText(busy)).toBeInTheDocument();
    expect(within(panel).queryByText(ALL_ARCHIVED_TEXT)).not.toBeInTheDocument();
  });

  it('keeps a stamp that holds an archived quality on offer for the qualities it does not hold', async () => {
    openPanelWith(makeOptions(), {});
    const panel = await screen.findByRole('dialog', { name: ARCHIVE_TITLE });

    expect(await within(panel).findByRole('checkbox', { name: /480p/ })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: /1080p/ })).toBeDisabled();
    expect(within(panel).getAllByText(ARCHIVED_ALREADY)).toHaveLength(2);
    expect(within(panel).queryByText(ALL_ARCHIVED_TEXT)).not.toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /Talks/ })).toBeChecked();
    expect(within(panel).queryByText(/is archived on this stamp already/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'before the copy starts' })).not.toBeInTheDocument();
  });
});

describe("the archive's Use another stamp", () => {
  it('greys out, with the reason, a stamp that holds an archived copy of a quality the archive copies', async () => {
    mockFetch(routes(makeOptions(), pausedCopy()));
    renderWithProviders(
      <JobProviders>
        <ArchivePanel />
      </JobProviders>,
    );

    // The pause asks the user who started the copy, so the panel comes to front for them.
    const panel = await screen.findByRole('dialog', { name: 'Archive of “Opening keynote”' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Use another stamp' }));
    const picker = await screen.findByRole('dialog', { name: 'Use another archive stamp' });

    expect(await within(picker).findByRole('radio', { name: /Talks/ })).toBeDisabled();
    expect(within(picker).getByText(/1080p is archived on this stamp already\./)).toBeInTheDocument();
    // The stamp in use is left out, and the first other one that takes what is left is chosen.
    expect(within(picker).getByRole('radio', { name: /Spring/ })).toBeChecked();
    expect(within(picker).queryByRole('radio', { name: new RegExp(UNNAMED_SHORT) })).not.toBeInTheDocument();
  });
});
