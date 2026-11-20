import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_PURCHASE_APPLY_TEXT,
  BATCH_PURCHASE_MOVE_OFF,
  BATCH_PURCHASE_RESTART_CONFIRM,
  XBZZ_DECIMALS,
  type BatchPurchase,
  type FundingBatch,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import { formatShort, formatUnits } from '../components/funding/amounts';
import {
  BUY_DAYS_PROBLEM,
  CATALOGUE_KIND_CAPTION,
  FOLLOW_UP_TEXT,
  paysNote,
  recommendationLine,
} from '../components/funding/BatchBuyDialog';
import {
  BATCH_PURCHASE_POLL_MS,
  BOUGHT_BATCH_RAN_OUT,
  NO_BATCH_SET,
  PURCHASE_TO_CHECK,
  PURCHASE_UNDER_WAY,
  purchasesReadFailed,
} from '../components/funding/batchPurchases';
import { moveText } from '../components/funding/BatchPurchaseLines';
import { FundingPage } from '../pages/FundingPage';
import {
  BATCH,
  DAY,
  makeArchiveStamps,
  makeBatch,
  makeNode,
  makeStampView,
  THIRTY_DAYS_DEPTH_20,
} from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders } from './helpers';

const FUNDING = '/api/funding';
const ARCHIVE_STAMPS = '/api/archive/stamps';
const PURCHASES = '/api/funding/batch-purchases';
const STAMP = '/api/catalogue-stamp';
const PURCHASE_ID = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';
const RESTART = `${PURCHASES}/${PURCHASE_ID}/restart`;
const CHECK = `${PURCHASES}/${PURCHASE_ID}/check`;

/** What 30 days cost a batch of depth 18 at the fixtures' price: a quarter of depth 20. */
const THIRTY_DAYS_DEPTH_18 = (BigInt(THIRTY_DAYS_DEPTH_20) / 4n).toString();

/**
 * The Stamps tab's view with what Buy new needs: the expired rung's batch, depth 20 and mutable, with the manager's
 * recommendation; a rung on the second stage with no batch, which the manager recommends depth 21 immutable for; and a
 * gateway with none and no recommendation. Every other batch pays, and has a recommendation too.
 */
function buyView(): FundingView {
  const base = makeStampView();
  const [main, second] = base.stages;
  return {
    ...base,
    catalogue: base.catalogue && { ...base.catalogue, replacement: { depth: 20, immutable: true } },
    stages: [
      {
        ...main,
        nodes: main.nodes.map((node) =>
          node.role === 'gateway'
            ? { ...node, replacement: null }
            : { ...node, replacement: { depth: 20, immutable: false } },
        ),
      },
      {
        ...second,
        nodes: [
          ...second.nodes,
          makeNode({
            nodeId: 'stage-2:480p',
            label: 'pool-480p',
            role: 'rung',
            batch: null,
            replacement: { depth: 21, immutable: true },
          }),
        ],
      },
    ],
  };
}

/** {@link buyView} with the 720p rung's batch replaced by `batch`, as another reading of the page finds it. */
function withRung720(batch: FundingBatch): FundingView {
  const view = buyView();
  return {
    ...view,
    stages: view.stages.map((stage) => ({
      ...stage,
      nodes: stage.nodes.map((node) => (node.nodeId === 'stage-1:720p' ? { ...node, batch } : node)),
    })),
  };
}

/** The view with the catalogue batch run out, and the manager recommending an immutable depth 18 in its place. */
function expiredCatalogueView(): FundingView {
  const view = buyView();
  return {
    ...view,
    catalogue: view.catalogue && {
      ...view.catalogue,
      batch: makeBatch({ immutable: true, usable: false, ttlSeconds: 0 }),
      replacement: { depth: 18, immutable: true },
    },
  };
}

function makePurchase(over: Partial<BatchPurchase> = {}): BatchPurchase {
  return {
    id: PURCHASE_ID,
    purpose: 'rung',
    nodeId: 'stage-1:720p',
    nodeLabel: 'rung-720p',
    depth: 20,
    immutable: false,
    days: 30,
    amountPerChunkPlur: '12441600000',
    costPlur: THIRTY_DAYS_DEPTH_20,
    replacesBatchId: BATCH.expired,
    state: 'buying',
    batchId: null,
    error: null,
    stages: [],
    move: null,
    canCheckAgain: false,
    startedBy: 'admin',
    startedAt: '2026-11-19T10:00:00.000Z',
    ...over,
  };
}

interface Serve {
  view?: () => FundingView;
  purchases?: () => BatchPurchase[] | Response;
  moveEnabled?: boolean;
  buy?: () => Response;
}

function serve({ view = buyView, purchases = () => [], moveEnabled = true, buy }: Serve = {}) {
  return mockFetch([
    { path: FUNDING, respond: () => jsonOk(view()) },
    { path: ARCHIVE_STAMPS, respond: () => jsonOk(makeArchiveStamps()) },
    {
      path: PURCHASES,
      respond: () => {
        const answer = purchases();
        return Array.isArray(answer) ? jsonOk({ purchases: answer }) : answer;
      },
    },
    { path: PURCHASES, method: 'POST', respond: () => (buy ? buy() : jsonOk(makePurchase(), 202)) },
    { path: RESTART, method: 'POST', respond: () => jsonOk(makePurchase()) },
    { path: CHECK, method: 'POST', respond: () => jsonOk(makePurchase()) },
    {
      path: STAMP,
      respond: () =>
        jsonOk({
          catalogueStamp: null,
          catalogueMove: {
            enabled: moveEnabled,
            waiting: null,
            refusal: null,
            latest: null,
            designatedBatchId: null,
            pinnedBatchId: null,
          },
        }),
    },
  ]);
}

const callsTo = (fetchMock: ReturnType<typeof mockFetch>, path: string, method = 'GET') =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET').toUpperCase() === method,
  );
const bodyOf = (fetchMock: ReturnType<typeof mockFetch>, path: string) =>
  JSON.parse(String(callsTo(fetchMock, path, 'POST')[0]?.[1]?.body)) as unknown;

async function openStamps() {
  renderWithProviders(<FundingPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
  await screen.findByRole('heading', { name: 'Catalogue batch' });
}

const xbzz = (plur: string) => `${formatShort(plur, XBZZ_DECIMALS)} xBZZ`;
/** The row of a batch, by its short id as the row shows it. */
const batchRow = (batchId: string) => screen.getByTitle(batchId, { exact: true }).closest('tr') as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
});

describe('Buy new on the Stamps tab', () => {
  it('offers Buy new on a batch that ran out and on a node with no batch, and nowhere else', async () => {
    serve();
    await openStamps();

    const expired = await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' });
    expect(expired.closest('tr')).toBe(batchRow(BATCH.expired));
    const missing = screen.getByRole('button', { name: 'Buy a new batch for pool-480p' });
    const missingRow = within(missing.closest('tr') as HTMLElement);
    expect(missingRow.getByText(NO_BATCH_SET)).toBeInTheDocument();
    expect(missingRow.getByText('No batch')).toBeInTheDocument();

    // The gateway has no recommendation, and every other batch still pays.
    expect(screen.getAllByRole('button', { name: /^Buy a new/ })).toHaveLength(2);
  });

  it('opens on the recommendation, prices it, and buys it after a confirm that names the cost', async () => {
    const fetchMock = serve();
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' }));

    const dialog = within(screen.getByRole('dialog', { name: 'Buy a new batch for rung-720p' }));
    expect(dialog.getByText(recommendationLine(20, false, true))).toBeInTheDocument();
    expect(dialog.getByRole('radio', { name: 'Depth 20' })).toBeChecked();
    expect(dialog.getByRole('radio', { name: 'Depth 17' })).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Mutable' })).toHaveAttribute('aria-pressed', 'true');
    expect(dialog.getByRole('textbox', { name: 'Days' })).toHaveValue('30');
    expect(dialog.getByText(/^Lasts 30 days at today's price, holds 4\.29 GB/)).toBeInTheDocument();
    expect(dialog.getByText('The wallet of rung-720p holds 5.000 xBZZ and 0.200 xDAI.')).toBeInTheDocument();

    fireEvent.click(dialog.getByRole('button', { name: `Next: ${xbzz(THIRTY_DAYS_DEPTH_20)}` }));
    const confirm = within(screen.getByRole('dialog', { name: 'Buy this batch?' }));
    expect(confirm.getByText(`${formatUnits(THIRTY_DAYS_DEPTH_20, XBZZ_DECIMALS)} xBZZ`)).toBeInTheDocument();
    expect(confirm.getByText(FOLLOW_UP_TEXT.rung)).toBeInTheDocument();
    expect(confirm.getByText(paysNote('rung-720p'))).toBeInTheDocument();
    const reads = callsTo(fetchMock, PURCHASES).length;
    fireEvent.click(confirm.getByRole('button', { name: `Buy for ${xbzz(THIRTY_DAYS_DEPTH_20)}` }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf(fetchMock, PURCHASES)).toEqual({
      purpose: 'rung',
      nodeId: 'stage-1:720p',
      replacesBatchId: BATCH.expired,
      depth: 20,
      immutable: false,
      days: 30,
      costPlur: THIRTY_DAYS_DEPTH_20,
    });
    await waitFor(() => expect(callsTo(fetchMock, PURCHASES).length).toBeGreaterThan(reads));
  });

  it('buys the first batch of a node with none, with no batch to replace', async () => {
    const fetchMock = serve();
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new batch for pool-480p' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('pool-480p has no batch set. This is its first.')).toBeInTheDocument();
    expect(dialog.getByText('Recommended: depth 21, immutable, 30 days.')).toBeInTheDocument();
    expect(dialog.getByRole('radio', { name: 'Depth 21' })).toBeChecked();
    expect(dialog.getByRole('button', { name: 'Immutable' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(dialog.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    await waitFor(() => expect(callsTo(fetchMock, PURCHASES, 'POST')).toHaveLength(1));
    expect(bodyOf(fetchMock, PURCHASES)).toMatchObject({
      purpose: 'rung',
      nodeId: 'stage-2:480p',
      replacesBatchId: null,
      depth: 21,
      immutable: true,
    });
  });

  it('refuses days under two, and a batch the wallet cannot pay for, with Fund it opening the Balance tab', async () => {
    serve();
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' }));
    const dialog = within(screen.getByRole('dialog'));

    fireEvent.change(dialog.getByRole('textbox', { name: 'Days' }), { target: { value: '1' } });
    expect(dialog.getByText(BUY_DAYS_PROBLEM)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Use it' }));
    expect(dialog.getByRole('textbox', { name: 'Days' })).toHaveValue('30');

    // Depth 22 for 30 days is 5.218 xBZZ, more than the 5 the wallet holds.
    fireEvent.click(dialog.getByRole('radio', { name: 'Depth 22' }));
    expect(dialog.getByText('Short 0.219 xBZZ for this batch.')).toBeInTheDocument();
    expect(dialog.getByText(/The node's wallet is \d+ PLUR short of the batch's cost\./)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /^Next/ })).toBeDisabled();

    fireEvent.click(dialog.getByRole('button', { name: 'Fund it' }));
    expect(await screen.findByRole('tab', { name: 'Balance', selected: true })).toBeInTheDocument();
  });

  it('shows the refusal in the dialog and reads the view again, so it prices at the new price', async () => {
    const message = 'The price of postage moved, and this batch now costs 1 PLUR. Confirm it again at that cost.';
    const fetchMock = serve({ buy: () => jsonError(409, { error: 'funding_refused', problem: 'price', message }) });
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' }));
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    const views = callsTo(fetchMock, FUNDING).length;
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Buy this batch?' })).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, FUNDING).length).toBeGreaterThan(views));
  });

  it('builds the offer again from the page read after a refusal, so the next confirm names the batch shown now', async () => {
    const message = 'The batch of rung-720p changed since the page showed it. Read the page again. Nothing was bought.';
    const another = `0x${'ef'.repeat(32)}`;
    let changed = false;
    const fetchMock = serve({
      view: () => (changed ? withRung720(makeBatch({ batchId: another, usable: false, ttlSeconds: 0 })) : buyView()),
      buy: () => {
        if (changed) return jsonOk(makePurchase(), 202);
        changed = true;
        return jsonError(409, { error: 'funding_refused', problem: 'batch', message });
      },
    });
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' }));
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    await screen.findByText(new RegExp(`in place of batch ${another.slice(0, 8)}`));

    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    await waitFor(() => expect(callsTo(fetchMock, PURCHASES, 'POST')).toHaveLength(2));
    const second = JSON.parse(String(callsTo(fetchMock, PURCHASES, 'POST')[1][1]?.body)) as { replacesBatchId: string };
    expect(second.replacesBatchId).toBe(another);
  });

  it('closes the dialog and says why once the row it was opened on offers Buy new no more', async () => {
    const message =
      'The batch of rung-720p still pays, so it is topped up or diluted rather than replaced. Nothing was bought.';
    let changed = false;
    serve({
      view: () =>
        changed ? withRung720(makeBatch({ batchId: `0x${'ef'.repeat(32)}`, ttlSeconds: 30 * DAY })) : buyView(),
      buy: () => {
        changed = true;
        return jsonError(409, { error: 'funding_refused', problem: 'batch', message });
      },
    });
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' }));
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy a new batch for rung-720p' })).not.toBeInTheDocument();
  });

  it('says the catalogue cannot be replaced while the move is off, and buys an immutable one while it is on', async () => {
    serve({ view: expiredCatalogueView, moveEnabled: false });
    const { unmount } = renderWithProviders(<FundingPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
    expect(await screen.findByText(BATCH_PURCHASE_MOVE_OFF)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy a new catalogue batch' })).not.toBeInTheDocument();
    unmount();

    const fetchMock = serve({ view: expiredCatalogueView, moveEnabled: true });
    await openStamps();
    fireEvent.click(await screen.findByRole('button', { name: 'Buy a new catalogue batch' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Buy a new catalogue batch' }));
    expect(dialog.getByText(CATALOGUE_KIND_CAPTION)).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Mutable' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('radio', { name: 'Depth 17' })).not.toBeInTheDocument();
    expect(dialog.getByRole('radio', { name: 'Depth 18' })).toBeChecked();
    fireEvent.click(dialog.getByRole('button', { name: `Next: ${xbzz(THIRTY_DAYS_DEPTH_18)}` }));
    expect(screen.getByText(FOLLOW_UP_TEXT.catalogue)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    await waitFor(() => expect(callsTo(fetchMock, PURCHASES, 'POST')).toHaveLength(1));
    expect(bodyOf(fetchMock, PURCHASES)).toMatchObject({
      purpose: 'catalogue',
      nodeId: buyView().catalogue?.nodeId,
      replacesBatchId: BATCH.catalogue,
      depth: 18,
      immutable: true,
      costPlur: THIRTY_DAYS_DEPTH_18,
    });
  });

  it('shows a line per stage under the row, with Restart now behind a confirm while a broadcast is live', async () => {
    const purchase = makePurchase({
      state: 'restarting',
      batchId: `0x${'12'.repeat(32)}`,
      canCheckAgain: true,
      stages: [
        { stageId: 'st-1', name: 'Main stage', apply: 'waiting_live', message: null },
        { stageId: 'st-2', name: 'Side stage', apply: 'waiting_settings', message: 'The ingest port changed.' },
        { stageId: 'st-3', name: 'Night stage', apply: 'applied', message: null },
        { stageId: 'st-4', name: 'Late stage', apply: 'failed', message: 'The uploader did not come back.' },
      ],
    });
    const fetchMock = serve({ purchases: () => [purchase] });
    await openStamps();

    const lines = within(await screen.findByRole('group', { name: 'Purchase for rung-720p' }));
    expect(within(batchRow(BATCH.expired)).getByText(PURCHASE_UNDER_WAY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy a new batch for rung-720p' })).not.toBeInTheDocument();
    for (const apply of ['waiting_live', 'waiting_settings', 'applied', 'failed'] as const) {
      expect(lines.getByText(`: ${BATCH_PURCHASE_APPLY_TEXT[apply]}`)).toBeInTheDocument();
    }
    expect(lines.getByText('The ingest port changed.')).toBeInTheDocument();
    expect(lines.getByText('The uploader did not come back.')).toBeInTheDocument();
    expect(lines.getAllByRole('button', { name: 'Restart now' })).toHaveLength(1);

    fireEvent.click(lines.getByRole('button', { name: 'Restart now' }));
    const confirm = within(screen.getByRole('dialog', { name: 'Restart the uploader of Main stage now?' }));
    expect(confirm.getByText(BATCH_PURCHASE_RESTART_CONFIRM)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(callsTo(fetchMock, RESTART, 'POST')).toHaveLength(1));
    expect(bodyOf(fetchMock, RESTART)).toEqual({ stageId: 'st-1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(lines.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(callsTo(fetchMock, CHECK, 'POST')).toHaveLength(1));
  });

  it('offers Restart now for a stage the manager cannot tell about, and none for one that waits on nothing', async () => {
    serve({
      purchases: () => [
        makePurchase({
          state: 'restarting',
          stages: [
            { stageId: 'st-1', name: 'Main stage', apply: 'waiting_unknown', message: null },
            { stageId: 'st-2', name: 'Side stage', apply: 'not_following', message: null },
            { stageId: 'st-3', name: 'Night stage', apply: 'stopped', message: null },
          ],
        }),
      ],
    });
    await openStamps();
    const lines = within(await screen.findByRole('group', { name: 'Purchase for rung-720p' }));
    expect(lines.getAllByRole('button', { name: 'Restart now' })).toHaveLength(1);
    expect(lines.getByText(`: ${BATCH_PURCHASE_APPLY_TEXT.not_following}`)).toBeInTheDocument();
    expect(lines.getByText(`: ${BATCH_PURCHASE_APPLY_TEXT.stopped}`)).toBeInTheDocument();
    expect(lines.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it("shows a catalogue purchase's move, its slots and the thumbnails it cleared", async () => {
    const move = {
      state: 'running' as const,
      slotsDone: 3,
      slotsTotal: 10,
      message: null,
      clearedThumbnails: [{ streamId: 's-9', title: 'Opening night' }],
      released: false,
    };
    serve({
      view: expiredCatalogueView,
      purchases: () => [
        makePurchase({
          purpose: 'catalogue',
          nodeId: buyView().catalogue?.nodeId ?? '',
          nodeLabel: 'catalogue-node',
          immutable: true,
          depth: 18,
          state: 'moving',
          move,
        }),
      ],
    });
    await openStamps();
    const lines = within(await screen.findByRole('group', { name: 'Purchase for catalogue-node' }));
    expect(lines.getByText(moveText(move))).toBeInTheDocument();
    expect(lines.getByRole('progressbar', { name: 'Catalogue move progress' })).toHaveAttribute('aria-valuenow', '30');
    expect(lines.getByRole('link', { name: 'Opening night' })).toHaveAttribute('href', '/streams/s-9');
  });

  it('holds Buy new while a stopped purchase waits for Check again, and offers it again once nothing is to check', async () => {
    const failed = makePurchase({ state: 'failed', error: 'The batch did not become usable in an hour.' });
    serve({ purchases: () => [{ ...failed, batchId: `0x${'12'.repeat(32)}`, canCheckAgain: true }] });
    const { unmount } = renderWithProviders(<FundingPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
    expect(await screen.findByText(PURCHASE_TO_CHECK)).toBeInTheDocument();
    expect(screen.getByText('Stopped: The batch did not become usable in an hour.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy a new batch for rung-720p' })).not.toBeInTheDocument();
    unmount();

    serve({ purchases: () => [failed] });
    await openStamps();
    expect(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' })).toBeInTheDocument();
  });

  it('holds Buy new while the bought batch is still on its node, whatever the manager has said of it', async () => {
    const bought = makePurchase({
      state: 'failed',
      error: 'The batch did not become usable in an hour.',
      batchId: `0x${'12'.repeat(32)}`,
      canCheckAgain: true,
    });
    for (const batchState of [undefined, 'active'] as const) {
      serve({ purchases: () => [{ ...bought, ...(batchState ? { batchState } : {}) }] });
      const { unmount } = renderWithProviders(<FundingPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
      expect(await screen.findByText(PURCHASE_TO_CHECK)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Buy a new batch for rung-720p' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
      expect(screen.queryByText(BOUGHT_BATCH_RAN_OUT)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('offers Buy new once the bought batch has run out, keeping the line without Check again', async () => {
    const bought = makePurchase({
      state: 'failed',
      error: 'The batch did not become usable in an hour.',
      batchId: `0x${'12'.repeat(32)}`,
      canCheckAgain: true,
    });
    for (const batchState of ['expired', 'gone'] as const) {
      serve({ purchases: () => [{ ...bought, batchState }] });
      const { unmount } = renderWithProviders(<FundingPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
      expect(await screen.findByRole('button', { name: 'Buy a new batch for rung-720p' })).toBeInTheDocument();
      const lines = within(screen.getByRole('group', { name: 'Purchase for rung-720p' }));
      expect(lines.getByText('Stopped: The batch did not become usable in an hour.')).toBeInTheDocument();
      expect(lines.getByText(BOUGHT_BATCH_RAN_OUT)).toBeInTheDocument();
      expect(lines.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
      expect(screen.queryByText(PURCHASE_TO_CHECK)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('says the purchases could not be read while a row offers Buy new', async () => {
    serve({ purchases: () => jsonError(500, { error: 'boom', message: 'The admin did not answer.' }) });
    await openStamps();
    expect(await screen.findByText(purchasesReadFailed('The admin did not answer.'))).toBeInTheDocument();
  });

  it('reads the purchases again while one is under way, and the view once it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let purchases = [makePurchase({ state: 'waiting_usable' })];
    const fetchMock = serve({ purchases: () => purchases });
    await openStamps();
    await screen.findByText(/waiting for the network/);
    const views = callsTo(fetchMock, FUNDING).length;

    purchases = [makePurchase({ state: 'done', batchId: `0x${'12'.repeat(32)}` })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BATCH_PURCHASE_POLL_MS);
    });
    await waitFor(() => expect(callsTo(fetchMock, FUNDING).length).toBeGreaterThan(views));
    expect(await screen.findByText('The new batch pays for uploads on every stage that takes it.')).toBeInTheDocument();
  });
});
