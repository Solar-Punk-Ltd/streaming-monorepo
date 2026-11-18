import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_PURCHASES_NOT_OFFERED,
  type ArchiveBuyChoice,
  type ArchiveStampsResponse,
  type FundingPostage,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import { archiveReadFailed, PURCHASE_POLL_MS } from '../components/funding/ArchiveStamps';
import { NO_ARCHIVE_STAMPS } from '../components/funding/BatchTable';
import {
  ARCHIVE_STAMP_UNREAD_TEXT,
  FORMER_CATALOGUE_NODE_TEXT,
  TOP_UP_ONLY_TEXT,
  WALLET_UNREAD_TEXT,
} from '../components/funding/stamps';
import { FundingPage } from '../pages/FundingPage';
import {
  ARCHIVE,
  BATCH,
  makeArchivePurchase,
  makeArchiveStamp,
  makeArchiveStamps,
  makeStampItem,
  makeStampView,
  POSTAGE,
  THIRTY_DAYS_DEPTH_20,
} from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';

const FUNDING = '/api/funding';
const ARCHIVE_STAMPS = '/api/archive/stamps';
const PURCHASES = '/api/archive/stamp-purchases';
const STAMPS = '/api/funding/stamp-operations';
const BULK = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';

/** The Stamps view of the fixtures. The archive stamps come from the admin's own answer, each naming its node. */
const archiveView = (): FundingView => makeStampView();

/**
 * The admin's archive stamps: "Talks" on the catalogue node, depth 20 here so the catalogue node's 5 xBZZ pay for it
 * and the catalogue batch together, and an older one left on the main stage's uploader, a node that is the catalogue
 * node no longer, which is not written any more and expires soon.
 */
function archiveStamps(over: Partial<ArchiveStampsResponse> = {}): ArchiveStampsResponse {
  return makeArchiveStamps({
    stamps: [
      makeArchiveStamp({ depth: 20 }),
      makeArchiveStamp({
        batchId: ARCHIVE.old.slice(2),
        label: null,
        nodeId: 'stage-1:bee',
        nodeLabel: 'stage-1-uploader',
        writable: false,
        ttlSeconds: 20 * 86_400,
        qualitiesArchived: 1,
        roomChunks: 0,
        expiresSoon: true,
      }),
    ],
    ...over,
  });
}

function serve(
  view: () => FundingView,
  stamps: () => ArchiveStampsResponse | Response = () => archiveStamps(),
  extra: Route[] = [],
) {
  return mockFetch([
    { path: FUNDING, respond: () => jsonOk(view()) },
    {
      path: ARCHIVE_STAMPS,
      respond: () => {
        const answer = stamps();
        return 'ok' in answer && typeof answer.ok === 'boolean' && 'json' in answer ? answer : jsonOk(answer);
      },
    },
    ...extra,
  ]);
}

const callsTo = (fetchMock: ReturnType<typeof mockFetch>, path: string, method = 'GET') =>
  fetchMock.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method);

const bodyOf = (fetchMock: ReturnType<typeof mockFetch>, path: string) =>
  JSON.parse(String(callsTo(fetchMock, path, 'POST')[0]?.[1]?.body)) as unknown;

/** The Funding page on its Stamps tab, once its archive group is drawn and, with `withStamps`, its stamps' rows. */
async function openStamps(withStamps = true) {
  renderWithProviders(<FundingPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
  await screen.findByRole('heading', { name: 'Archive stamps' });
  if (withStamps) await screen.findByRole('table', { name: 'Archive stamps' });
}

const archiveTable = () => within(screen.getByRole('table', { name: 'Archive stamps' }));
const rowOf = (text: string) => within(archiveTable().getByText(text).closest('tr') as HTMLElement);

afterEach(() => {
  vi.useRealTimers();
});

describe('the archive stamps on the Stamps tab', () => {
  it('lists them under the catalogue batch and above the stages, with their label, room and qualities', async () => {
    serve(archiveView);
    await openStamps();

    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Catalogue batch',
      'Archive stamps',
      'Main stage',
      'Second stage',
    ]);
    const talks = rowOf('Talks');
    expect(talks.getByText('0x9a9a9a…9a9a9a')).toHaveAttribute('title', ARCHIVE.talks);
    expect(talks.getByText('Immutable')).toBeInTheDocument();
    expect(talks.getByText('On catalogue-node · Room for 4.1 GB · 3 qualities on it')).toBeInTheDocument();
    expect(talks.getByText('200 days')).toBeInTheDocument();

    const old = rowOf('No label');
    expect(old.getByText('Top-ups only')).toBeInTheDocument();
    expect(old.getByText('On stage-1-uploader · Room for 0 B · 1 quality on it')).toBeInTheDocument();
    expect(old.getByText('Under 30 days left.')).toBeInTheDocument();
  });

  it('says there are none yet while the catalogue node has none, and still offers Buy', async () => {
    const fetchMock = serve(makeStampView, () => makeArchiveStamps());
    await openStamps(false);
    await waitFor(() => expect(callsTo(fetchMock, ARCHIVE_STAMPS)).not.toHaveLength(0));
    expect(screen.getByText(NO_ARCHIVE_STAMPS)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy archive stamp' })).toBeEnabled();
  });

  it("tops one up with the catalogue batch, both paid from the catalogue node's one wallet", async () => {
    const sent = makeStampItem();
    const fetchMock = serve(archiveView, undefined, [
      { path: STAMPS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: [sent] }, 202) },
      { path: STAMPS, respond: () => jsonOk({ items: [sent] }) },
    ]);
    await openStamps();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Top up the batch of catalogue-node' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Top up the archive stamp Talks' }));
    // 30 days of depth 20 twice, 2.609 xBZZ, out of the node's 5: 2.391 after, on both rows.
    expect(within(screen.getByRole('table', { name: 'Catalogue batch' })).getByText('2.391 xBZZ')).toBeInTheDocument();
    expect(rowOf('Talks').getByText('2.391 xBZZ')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Top up 2 batches' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Top up 2 batches?' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Top up' })).toBeEnabled());
    fireEvent.click(dialog.getByRole('button', { name: 'Top up' }));
    await screen.findByRole('table', { name: 'Stamp operations sent' });
    const price = POSTAGE.pricePerChunkPerBlockPlur;
    expect(bodyOf(fetchMock, STAMPS)).toEqual({
      items: [
        {
          kind: 'topup',
          nodeId: 'catalogue:bee',
          batchId: BATCH.catalogue,
          expectedDepth: 20,
          days: 30,
          pricePerChunkPerBlockPlur: price,
        },
        {
          kind: 'topup',
          nodeId: 'catalogue:bee',
          batchId: ARCHIVE.talks,
          expectedDepth: 20,
          days: 30,
          pricePerChunkPerBlockPlur: price,
        },
      ],
    });
  });

  it('says the catalogue node is short when its batches together cost more than it holds', async () => {
    serve(archiveView, () => makeArchiveStamps({ stamps: [makeArchiveStamp()] }));
    await openStamps();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Top up the batch of catalogue-node' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Top up the archive stamp Talks' }));
    // 1.305 for the catalogue batch and 5.218 for the archive stamp of depth 22: 1.523 more than the node's 5.
    expect(screen.getByText('catalogue-node is short of 1.523 xBZZ for its top-ups.')).toBeInTheDocument();
  });

  it('dilutes a stamp still written, and only tops up one left on a node that is the catalogue node no longer', async () => {
    serve(archiveView);
    await openStamps();
    expect(rowOf('No label').getByRole('checkbox')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dilute' }));
    expect(rowOf('No label').queryByRole('checkbox')).not.toBeInTheDocument();
    expect(rowOf('No label').getByText(TOP_UP_ONLY_TEXT)).toBeInTheDocument();
    expect(rowOf('Talks').getByRole('checkbox', { name: 'Dilute the archive stamp Talks' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Dilute every archive stamp' }));
    expect(screen.getByRole('button', { name: 'Dilute 1 batch' })).toBeInTheDocument();
  });

  it('says why the archive stamps could not be read, and lists the other batches all the same', async () => {
    serve(archiveView, () => jsonError(500, { error: 'internal_error' }));
    await openStamps(false);
    expect(await screen.findByText(archiveReadFailed('The server hit an unexpected error.'))).toBeInTheDocument();
    expect(screen.getByText(NO_ARCHIVE_STAMPS)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Catalogue batch' })).toBeInTheDocument();
  });

  it("names the node a stamp is on, and says why one whose node's wallet was not read, or one not read, can't be ticked", async () => {
    serve(
      () => {
        const view = makeStampView();
        const [uploader, ...rest] = view.stages[0]?.nodes ?? [];
        if (view.stages[0] && uploader) {
          view.stages[0].nodes = [
            { ...uploader, walletAddress: null, xdaiWei: null, xbzzPlur: null, readError: 'The node did not answer.' },
            ...rest,
          ];
        }
        return view;
      },
      () =>
        makeArchiveStamps({
          stamps: [
            makeArchiveStamp({
              batchId: ARCHIVE.old.slice(2),
              label: 'Old',
              nodeId: 'stage-1:bee',
              nodeLabel: 'stage-1-uploader',
              writable: false,
            }),
            makeArchiveStamp({ state: 'unknown', ttlSeconds: null, fillRatio: null, writable: false }),
          ],
        }),
    );
    await openStamps();
    const old = rowOf('Old');
    expect(old.getByText(/^On stage-1-uploader/)).toBeInTheDocument();
    expect(old.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(old.getByText(WALLET_UNREAD_TEXT)).toBeInTheDocument();
    expect(old.getByText('Top-ups only')).toBeInTheDocument();
    const unread = rowOf('Talks');
    expect(unread.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(unread.getByText(ARCHIVE_STAMP_UNREAD_TEXT)).toBeInTheDocument();
    expect(unread.queryByText('Top-ups only')).not.toBeInTheDocument();
  });

  it('says a stamp on a node that is the catalogue node no longer is not topped up or diluted here, with no Top-ups only', async () => {
    serve(archiveView, () =>
      makeArchiveStamps({
        stamps: [
          makeArchiveStamp({
            batchId: ARCHIVE.old.slice(2),
            label: 'Gone',
            nodeId: 'gone:bee',
            nodeLabel: 'old-node',
            writable: false,
          }),
        ],
      }),
    );
    await openStamps();
    const gone = rowOf('Gone');
    expect(gone.getByText(/^On old-node/)).toBeInTheDocument();
    expect(gone.queryByText('Top-ups only')).not.toBeInTheDocument();
    expect(gone.queryByText(WALLET_UNREAD_TEXT)).not.toBeInTheDocument();
    expect(gone.getByText(FORMER_CATALOGUE_NODE_TEXT)).toBeInTheDocument();
    expect(gone.queryByRole('checkbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dilute' }));
    expect(rowOf('Gone').getByText(FORMER_CATALOGUE_NODE_TEXT)).toBeInTheDocument();
    expect(rowOf('Gone').queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('lists the stamps first while no catalogue node is designated, since they still need their top-ups', async () => {
    serve(
      () => makeStampView({ catalogue: null }),
      () => makeArchiveStamps({ stamps: [makeArchiveStamp({ nodeId: 'stage-1:bee', nodeLabel: 'stage-1-uploader' })] }),
    );
    renderWithProviders(<FundingPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
    await screen.findByRole('table', { name: 'Archive stamps' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Archive stamps',
      'Main stage',
      'Second stage',
    ]);
    expect(rowOf('Talks').getByRole('checkbox', { name: 'Top up the archive stamp Talks' })).toBeInTheDocument();
  });
});

describe('buying an archive stamp from the Stamps tab', () => {
  it('opens the buy dialog with every depth, and starts the purchase chosen', async () => {
    let stamps = archiveStamps();
    const purchase = makeArchivePurchase();
    const fetchMock = serve(archiveView, () => stamps, [
      {
        path: PURCHASES,
        method: 'POST',
        respond: () => {
          stamps = archiveStamps({ purchases: [purchase] });
          return jsonOk(purchase, 202);
        },
      },
    ]);
    await openStamps();
    await waitFor(() => expect(callsTo(fetchMock, ARCHIVE_STAMPS)).not.toHaveLength(0));
    await screen.findByText('On catalogue-node · Room for 4.1 GB · 3 qualities on it');

    fireEvent.click(screen.getByRole('button', { name: 'Buy archive stamp' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Buy an archive stamp' }));
    expect(dialog.getAllByRole('radio')).toHaveLength(25);
    fireEvent.click(dialog.getByRole('radio', { name: 'Depth 20' }));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Label (optional)' }), { target: { value: 'Spring' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Next: 1.305 xBZZ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy for 1.305 xBZZ' }));

    expect(await screen.findByText('Being bought: depth 20 “Spring”, 1.305 xBZZ.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bodyOf(fetchMock, PURCHASES)).toEqual({
      depth: 20,
      days: 30,
      label: 'Spring',
      costPlur: THIRTY_DAYS_DEPTH_20,
    });
  });

  it('says in the dialog that the manager offers no purchases when the API answers so', async () => {
    serve(archiveView, undefined, [
      {
        path: PURCHASES,
        method: 'POST',
        respond: () =>
          jsonError(409, {
            error: 'archive_refused',
            problem: 'purchases_not_offered',
            message: ARCHIVE_PURCHASES_NOT_OFFERED,
          }),
      },
    ]);
    await openStamps();
    await screen.findByText('On catalogue-node · Room for 4.1 GB · 3 qualities on it');
    fireEvent.click(screen.getByRole('button', { name: 'Buy archive stamp' }));
    await screen.findByRole('dialog', { name: 'Buy an archive stamp' });
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    expect(await screen.findByText(ARCHIVE_PURCHASES_NOT_OFFERED)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Buy this archive stamp?' })).toBeInTheDocument();
  });

  it('reads the stamps again after a refusal, so the next confirm sends the cost at the new price', async () => {
    // The price of postage moves before the first purchase reaches the API, from 24000 PLUR to 30000.
    const moved: FundingPostage = { ...POSTAGE, pricePerChunkPerBlockPlur: '30000' };
    /** What 30 days cost a batch of depth 20 at the moved price, in PLUR: 1.631 xBZZ. */
    const movedCost = '16307453952000000';
    let postage = POSTAGE;
    const terms = makeArchiveStamps().buy;
    const fetchMock = serve(archiveView, () => archiveStamps({ buy: terms && { ...terms, postage } }), [
      {
        path: PURCHASES,
        method: 'POST',
        respond: (init) => {
          postage = moved;
          const choice = JSON.parse(String(init?.body)) as ArchiveBuyChoice;
          if (choice.costPlur === movedCost) return jsonOk(makeArchivePurchase({ costPlur: movedCost }), 202);
          return jsonError(409, {
            error: 'archive_refused',
            problem: 'price_moved',
            message: `The price of postage moved, and this stamp now costs ${movedCost} PLUR. Confirm it again at that cost.`,
          });
        },
      },
    ]);
    await openStamps();
    await screen.findByText('On catalogue-node · Room for 4.1 GB · 3 qualities on it');
    fireEvent.click(screen.getByRole('button', { name: 'Buy archive stamp' }));
    const choose = within(await screen.findByRole('dialog', { name: 'Buy an archive stamp' }));
    fireEvent.click(choose.getByRole('radio', { name: 'Depth 20' }));
    fireEvent.click(choose.getByRole('button', { name: 'Next: 1.305 xBZZ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy for 1.305 xBZZ' }));

    const refused = /this stamp now costs 16307453952000000 PLUR/;
    expect(await screen.findByText(refused)).toBeInTheDocument();
    const buy = await screen.findByRole('button', { name: 'Buy for 1.631 xBZZ' });
    expect(screen.getByRole('dialog', { name: 'Buy this archive stamp?' })).toBeInTheDocument();
    expect(screen.getByText(refused)).toBeInTheDocument();

    fireEvent.click(buy);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const bodies = callsTo(fetchMock, PURCHASES, 'POST').map(([, init]) => JSON.parse(String(init?.body)) as unknown);
    expect(bodies).toEqual([
      { depth: 20, days: 30, label: null, costPlur: THIRTY_DAYS_DEPTH_20 },
      { depth: 20, days: 30, label: null, costPlur: movedCost },
    ]);
  });

  it('keeps Buy on and says why when no stamp can be bought now', async () => {
    const why = 'No catalogue node is designated, so no archive stamp can be bought.';
    serve(archiveView, () => archiveStamps({ buy: null, buyUnavailable: why }));
    await openStamps();
    await screen.findByText('On catalogue-node · Room for 4.1 GB · 3 qualities on it');
    fireEvent.click(screen.getByRole('button', { name: 'Buy archive stamp' }));
    expect(screen.getByText(why)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reads the stamps again while a purchase runs, and the view once it is usable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stamps = archiveStamps({ purchases: [makeArchivePurchase({ state: 'waiting_usable' })] });
    const fetchMock = serve(archiveView, () => stamps);
    await openStamps();
    await screen.findByText('Bought, waiting to be usable: depth 20 “Spring”, 1.305 xBZZ.');
    const views = callsTo(fetchMock, FUNDING).length;

    stamps = archiveStamps();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PURCHASE_POLL_MS);
    });
    await waitFor(() => expect(callsTo(fetchMock, FUNDING).length).toBeGreaterThan(views));
    expect(screen.queryByText(/waiting to be usable/)).not.toBeInTheDocument();
  });
});
