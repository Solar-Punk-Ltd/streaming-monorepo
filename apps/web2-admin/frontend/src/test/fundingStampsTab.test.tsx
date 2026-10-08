import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FundingStampItem, FundingView } from '@streaming-monorepo/web2-admin-common';

import { EARLIER_STAMP_OPERATIONS_SETTLING } from '../api';
import { EXPLORER_TX_URL } from '../components/funding/balance';
import { BULK_POLL_LIMIT_MS, BULK_POLL_MS } from '../components/funding/BulkProgress';
import { DILUTE_NOTE, TOP_UP_NOTE } from '../components/funding/StampDialog';
import { READ_BACK_NOTE, STAMP_DROPPED_NOTE, STAMP_NOT_KNOWN_YET_NOTE } from '../components/funding/StampProgress';
import { DAYS_PROBLEM, EXPIRED_TEXT, NO_PRICE_PROBLEM } from '../components/funding/stamps';
import { NO_BATCHES_REPORTED, TODAYS_PRICE_CAPTION } from '../components/funding/StampsTab';
import { FundingPage } from '../pages/FundingPage';
import { BATCH, makeBatch, makeNode, makeStampItem, makeStampView, makeView } from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';

const FUNDING = '/api/funding';
const STAMPS = '/api/funding/stamp-operations';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BULK = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const WAIT = 'Wait for the stamp operations above to finish.';

/** The funding view, answered from a getter so a test can change it between two reads. */
function serve(view: () => FundingView | Response, extra: Route[] = []) {
  return mockFetch([
    {
      path: FUNDING,
      respond: () => {
        const answer = view();
        return 'ok' in answer && typeof answer.ok === 'boolean' && 'json' in answer ? answer : jsonOk(answer);
      },
    },
    ...extra,
  ]);
}

const bodyOf = (fetchMock: ReturnType<typeof mockFetch>, path: string) => {
  const call = fetchMock.mock.calls.find(([url, init]) => String(url) === path && init?.method === 'POST');
  return JSON.parse(String(call?.[1]?.body)) as unknown;
};

/** How many times the page read a stamp bulk, and how many times the view. */
const pollsOf = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${STAMPS}?`)).length;
const viewsOf = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === FUNDING).length;

/** The Funding page on its Stamps tab, once its batches are drawn. */
async function openStamps() {
  renderWithProviders(<FundingPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
  await screen.findByRole('heading', { name: 'Catalogue batch' });
}

const table = (name: string) => within(screen.getByRole('table', { name }));
const rowOf = (name: string, text: string) => within(table(name).getByText(text).closest('tr') as HTMLElement);
const tick = (label: string, verb = 'Top up') =>
  fireEvent.click(screen.getByRole('checkbox', { name: `${verb} the batch of ${label}` }));
const typeDays = (value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Days' }), { target: { value } });

afterEach(() => {
  vi.useRealTimers();
});

describe('the batches', () => {
  it("lists the catalogue batch on top, then each stage's, each with its node, depth, time left and fill", async () => {
    serve(() => makeStampView());
    await openStamps();

    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Catalogue batch',
      'Main stage',
      'Second stage',
    ]);
    expect(screen.getByText(/^Batches as the manager read them/)).toBeInTheDocument();

    const catalogue = rowOf('Catalogue batch', 'catalogue-node');
    expect(catalogue.getByText('0xaaaaaa…aaaaaa')).toHaveAttribute('title', BATCH.catalogue);
    expect(catalogue.getByRole('button', { name: 'copy batch id' })).toBeInTheDocument();
    expect(catalogue.getByText('uploader')).toBeInTheDocument();
    expect(catalogue.getByText('Confirmed')).toBeInTheDocument();
    expect(catalogue.getByText('20')).toBeInTheDocument();
    expect(catalogue.getByText('40 days')).toBeInTheDocument();
    expect(catalogue.getByText('25%')).toBeInTheDocument();
    expect(catalogue.queryByText('Immutable')).not.toBeInTheDocument();

    const uploader = rowOf('Batches of Main stage', 'stage-1-uploader');
    expect(uploader.getByText('Main stage · uploader')).toBeInTheDocument();
    expect(uploader.getByText('Immutable')).toBeInTheDocument();
    expect(uploader.getByText('22')).toBeInTheDocument();
    expect(uploader.getByText('12 days')).toBeInTheDocument();
    expect(uploader.getByText('50%')).toBeInTheDocument();

    // A gateway has no batch, so no row.
    expect(table('Batches of Main stage').queryByText('stage-1-gateway')).not.toBeInTheDocument();
    expect(screen.getByText(TODAYS_PRICE_CAPTION)).toBeInTheDocument();
  });

  it('has no tick box for an expired batch or one its node could not be read about, and says why instead', async () => {
    serve(() => makeStampView());
    await openStamps();

    const expired = rowOf('Batches of Main stage', 'rung-720p');
    expect(expired.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(expired.getByText('Expired')).toBeInTheDocument();
    expect(expired.getByText(EXPIRED_TEXT)).toBeInTheDocument();

    const unread = rowOf('Batches of Main stage', 'rung-1080p');
    expect(unread.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(unread.getByText('The node did not answer in time.')).toBeInTheDocument();

    expect(rowOf('Batches of Main stage', 'stage-1-uploader').getByRole('checkbox')).not.toBeChecked();
  });

  it('says when the manager reports no batches, as one older than the Stamps tab does', async () => {
    serve(() => makeView());
    await openStamps();

    expect(screen.getByText(NO_BATCHES_REPORTED)).toBeInTheDocument();
    expect(screen.getByText('The manager reports no catalogue batch.')).toBeInTheDocument();
    expect(screen.getAllByText('The manager reports no batch for this stage.')).toHaveLength(2);
  });
});

describe('topping up', () => {
  it("shows a ticked batch's time left after, its cost and its node's xBZZ after, and what they come to", async () => {
    serve(() => makeStampView());
    await openStamps();

    const catalogue = rowOf('Catalogue batch', 'catalogue-node');
    expect(catalogue.getAllByText('—')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Top up 0 batches' })).toBeDisabled();
    expect(screen.getByText('Tick a batch to top it up.')).toBeInTheDocument();

    tick('catalogue-node');
    expect(catalogue.getByText('70 days')).toBeInTheDocument();
    expect(catalogue.getByText('1.305 xBZZ')).toHaveAttribute('title', '1.30459631616 xBZZ');
    expect(catalogue.getByText('3.695 xBZZ')).toHaveAttribute('title', '3.69540368384 xBZZ');
    expect(screen.getByText('To top up: 1 batch, 30 days more each, 1.30459631616 xBZZ in all.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeEnabled();

    tick('catalogue-node');
    expect(catalogue.queryByText('70 days')).not.toBeInTheDocument();
    expect(catalogue.getAllByText('—')).toHaveLength(3);
  });

  it('applies the days of the slider, a preset or the field to every ticked batch, with no cap in the field', async () => {
    serve(() => makeStampView());
    await openStamps();
    tick('catalogue-node');
    tick('pool-360p');
    const catalogue = rowOf('Catalogue batch', 'catalogue-node');
    const rung = rowOf('Batches of Second stage', 'pool-360p');
    const field = screen.getByRole('textbox', { name: 'Days' });
    const slider = screen.getByRole('slider', { name: 'Days to top up by' });
    expect(field).toHaveValue('30');
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(field).toHaveValue('7');
    expect(slider).toHaveAttribute('aria-valuenow', '7');
    expect(catalogue.getByText('47 days')).toBeInTheDocument();
    expect(rung.getByText('17 days')).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '120' } });
    expect(field).toHaveValue('120');
    expect(catalogue.getByText('160 days')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'false');

    typeDays('400');
    expect(slider).toHaveAttribute('aria-valuenow', '365');
    expect(catalogue.getByText('440 days')).toBeInTheDocument();
    expect(screen.getByText(/^To top up: 2 batches, 400 days more each, /)).toBeInTheDocument();

    // Only digits reach the field.
    typeDays('40.5');
    expect(field).toHaveValue('400');

    typeDays('');
    expect(screen.getByText(DAYS_PROBLEM)).toBeInTheDocument();
    expect(field.closest('[title]')).toHaveAttribute('title', DAYS_PROBLEM);
    expect(screen.getByRole('button', { name: 'Top up 2 batches' })).toBeDisabled();
    expect(catalogue.getAllByText('—')).toHaveLength(3);

    typeDays('0');
    expect(screen.getByText(DAYS_PROBLEM)).toBeInTheDocument();
    typeDays('1');
    expect(catalogue.getByText('41 days')).toBeInTheDocument();
    expect(screen.queryByText(DAYS_PROBLEM)).not.toBeInTheDocument();
  });

  it('shows a node short of xBZZ in red, and its Fund link opens the Balance tab with what it lacks entered', async () => {
    serve(() => makeStampView());
    await openStamps();

    tick('stage-1-uploader');
    const row = rowOf('Batches of Main stage', 'stage-1-uploader');
    expect(row.getByText('42 days')).toBeInTheDocument();
    expect(row.getByText('5.218 xBZZ')).toHaveAttribute('title', '5.21838526464 xBZZ');
    expect(row.getByText('Short 0.219 xBZZ')).toHaveAttribute('title', '0.21838526464 xBZZ short');
    expect(screen.getByText('stage-1-uploader is short of 0.219 xBZZ for its top-ups.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeDisabled();

    fireEvent.click(row.getByRole('button', { name: 'Fund stage-1-uploader' }));
    expect(screen.getByRole('tab', { name: 'Balance', selected: true })).toBeInTheDocument();
    const field = await screen.findByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' });
    expect(field).toHaveValue('0.219');
    expect(field).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Send to stage-1-uploader' })).toBeChecked();
    expect(screen.getByText(/0\.219 of 12\.5 xBZZ/)).toBeInTheDocument();

    // A Balance tab picked by hand opens with nothing entered.
    fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
    await screen.findByRole('heading', { name: 'Catalogue batch' });
    fireEvent.click(screen.getByRole('tab', { name: 'Balance' }));
    expect(await screen.findByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' })).toHaveValue('');
  });

  it('holds a node with no xDAI for the gas, and one whose price of postage is not known', async () => {
    const view = makeStampView({ postage: null });
    if (view.catalogue) view.catalogue = { ...view.catalogue, xdaiWei: '0' };
    serve(() => view);
    await openStamps();

    tick('catalogue-node');
    expect(rowOf('Catalogue batch', 'catalogue-node').getAllByText('—')).toHaveLength(3);
    expect(screen.getByText(NO_PRICE_PROBLEM)).toBeInTheDocument();
    expect(screen.getByText('catalogue-node holds no xDAI to pay the gas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeDisabled();
  });

  it('ticks a batch two stages share in both places, and asks for it once', async () => {
    const pooled = `0x${'ff'.repeat(32)}`;
    const shared = makeNode({
      nodeId: 'pool:720p',
      label: 'shared-720p',
      role: 'rung',
      batch: makeBatch({ batchId: pooled }),
    });
    const view = makeStampView();
    view.stages[0]?.nodes.push(shared);
    view.stages[1]?.nodes.push(shared);
    const sent = makeStampItem({ nodeId: 'pool:720p', nodeLabel: 'shared-720p', batchId: pooled });
    const fetchMock = serve(
      () => view,
      [
        { path: STAMPS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: [sent] }, 202) },
        { path: STAMPS, respond: () => jsonOk({ items: [sent] }) },
      ],
    );
    await openStamps();

    const boxes = () => screen.getAllByRole('checkbox', { name: 'Top up the batch of shared-720p' });
    expect(boxes()).toHaveLength(2);
    fireEvent.click(boxes()[1] as HTMLElement);
    expect(boxes().map((box) => (box as HTMLInputElement).checked)).toEqual([true, true]);

    fireEvent.click(screen.getByRole('button', { name: 'Top up 1 batch' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Top up 1 batch?' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Top up' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, STAMPS)).toEqual({
        items: [{ kind: 'topup', nodeId: 'pool:720p', batchId: pooled, expectedDepth: 20, days: 30 }],
      }),
    );
  });
});

describe('diluting', () => {
  it('shows the new depth and the time left after, by one step or two, and refuses under 7 days', async () => {
    serve(() => makeStampView());
    await openStamps();

    tick('catalogue-node');
    fireEvent.click(screen.getByRole('button', { name: 'Dilute' }));
    // The ticks go with the operation they were made for.
    expect(screen.getByRole('checkbox', { name: 'Dilute the batch of catalogue-node' })).not.toBeChecked();
    expect(
      table('Catalogue batch')
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['', 'Batch', 'Depth', 'Time left', 'Fill', 'New depth', 'Time left after']);
    expect(screen.getByText(TODAYS_PRICE_CAPTION)).toBeInTheDocument();

    tick('catalogue-node', 'Dilute');
    const catalogue = rowOf('Catalogue batch', 'catalogue-node');
    expect(catalogue.getByText('21')).toBeInTheDocument();
    expect(catalogue.getByText('20 days')).toBeInTheDocument();
    expect(screen.getByText('To dilute: 1 batch, 1 step deeper each.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dilute 1 batch' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '2 steps' }));
    expect(catalogue.getByText('22')).toBeInTheDocument();
    expect(catalogue.getByText('10 days')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '1 step' }));
    tick('stage-1-uploader', 'Dilute');
    const uploader = rowOf('Batches of Main stage', 'stage-1-uploader');
    expect(uploader.getByText('6 days 0 h')).toBeInTheDocument();
    expect(uploader.getByText('It would leave the batch under 7 days.')).toBeInTheDocument();
    expect(
      screen.getByText('The batch 0xbbbbbb…bbbbbb of stage-1-uploader: It would leave the batch under 7 days.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dilute 2 batches' })).toBeDisabled();
  });

  it('asks for dilutions in a dialog that says they cost only gas, with no password', async () => {
    const sent = makeStampItem({ kind: 'dilute', days: null, steps: 2, costPlur: null });
    const fetchMock = serve(
      () => makeStampView(),
      [
        { path: STAMPS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: [sent] }, 202) },
        { path: STAMPS, respond: () => jsonOk({ items: [sent] }) },
      ],
    );
    await openStamps();

    fireEvent.click(screen.getByRole('button', { name: 'Dilute' }));
    fireEvent.click(screen.getByRole('button', { name: '2 steps' }));
    tick('catalogue-node', 'Dilute');
    fireEvent.click(screen.getByRole('button', { name: 'Dilute 1 batch' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Dilute 1 batch?' }));
    expect(dialog.getByText('catalogue-node')).toBeInTheDocument();
    expect(dialog.getByText('Depth 20 to 22')).toBeInTheDocument();
    expect(dialog.getByText('10 days left after')).toBeInTheDocument();
    expect(dialog.getByText(DILUTE_NOTE)).toBeInTheDocument();
    expect(dialog.queryByLabelText('Your password')).not.toBeInTheDocument();

    fireEvent.click(dialog.getByRole('button', { name: 'Dilute' }));
    const progress = within(await screen.findByRole('table', { name: 'Stamp operations sent' }));
    expect(progress.getByText('Dilute 2 steps')).toBeInTheDocument();
    expect(bodyOf(fetchMock, STAMPS)).toEqual({
      items: [{ kind: 'dilute', nodeId: 'catalogue:bee', batchId: BATCH.catalogue, expectedDepth: 20, steps: 2 }],
    });
  });
});

describe('asking for a stamp bulk', () => {
  it('confirms the top-ups with each cost and no password, then follows each until it is confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let confirmed = false;
    const items = (): FundingStampItem[] => [
      makeStampItem({
        txHash: confirmed ? TX_HASH : null,
        state: confirmed ? 'confirmed' : 'submitted',
        settled: confirmed,
      }),
      makeStampItem({
        requestId: 'stamp-request-2',
        nodeId: 'stage-2:360p',
        nodeLabel: 'pool-360p',
        batchId: BATCH.rung,
        state: confirmed ? 'confirmed' : 'queued',
        settled: confirmed,
      }),
    ];
    const fetchMock = serve(
      () => makeStampView(),
      [
        { path: STAMPS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: items() }, 202) },
        { path: STAMPS, respond: () => jsonOk({ items: items() }) },
      ],
    );
    await openStamps();

    tick('catalogue-node');
    tick('pool-360p');
    fireEvent.click(screen.getByRole('button', { name: 'Top up 2 batches' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Top up 2 batches?' }));
    const asked = within(dialog.getByRole('table', { name: 'Top-ups to ask for' }));
    expect(asked.getByText('catalogue-node')).toBeInTheDocument();
    expect(asked.getByText('pool-360p')).toBeInTheDocument();
    expect(asked.getAllByText('30 days')).toHaveLength(2);
    expect(asked.getAllByText('1.30459631616 xBZZ')).toHaveLength(2);
    expect(dialog.getByText('In all: 2.60919263232 xBZZ.')).toBeInTheDocument();
    expect(dialog.getByText(TOP_UP_NOTE)).toBeInTheDocument();
    expect(dialog.queryByLabelText('Your password')).not.toBeInTheDocument();

    fireEvent.click(dialog.getByRole('button', { name: 'Top up' }));
    expect(await screen.findByRole('heading', { name: 'Stamp operations' })).toBeInTheDocument();
    expect(bodyOf(fetchMock, STAMPS)).toEqual({
      items: [
        { kind: 'topup', nodeId: 'catalogue:bee', batchId: BATCH.catalogue, expectedDepth: 20, days: 30 },
        { kind: 'topup', nodeId: 'stage-2:360p', batchId: BATCH.rung, expectedDepth: 20, days: 30 },
      ],
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Top up the batch of catalogue-node' })).not.toBeChecked();
    const progress = within(screen.getByRole('table', { name: 'Stamp operations sent' }));
    expect(progress.getAllByText('Top up 30 days, 1.30459631616 xBZZ')).toHaveLength(2);
    expect(progress.getByText('Sent')).toBeInTheDocument();
    expect(progress.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 done. This page reads them again every few seconds.')).toBeInTheDocument();
    expect(screen.getByText(READ_BACK_NOTE)).toBeInTheDocument();

    // A new stamp bulk waits for this one.
    tick('catalogue-node');
    expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeDisabled();
    expect(screen.getByText(WAIT)).toBeInTheDocument();

    const views = viewsOf(fetchMock);
    confirmed = true;
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));
    expect(await screen.findByText('Done: all 2 stamp operations are confirmed.')).toBeInTheDocument();
    expect(progress.getByRole('link', { name: /0xabababab/ })).toHaveAttribute('href', `${EXPLORER_TX_URL}${TX_HASH}`);
    // Settled, so the view is read again and a new stamp bulk may go.
    await waitFor(() => expect(viewsOf(fetchMock)).toBeGreaterThan(views));
    expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeEnabled();
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument();

    const ended = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS * 3));
    expect(pollsOf(fetchMock)).toBe(ended);
  });

  it('says in the dialog why it was refused, an earlier bulk still settling in its own words, and reads the view again', async () => {
    let answer = jsonError(409, { error: 'conflict', message: 'busy' });
    const fetchMock = serve(() => makeStampView(), [{ path: STAMPS, method: 'POST', respond: () => answer }]);
    await openStamps();

    tick('catalogue-node');
    fireEvent.click(screen.getByRole('button', { name: 'Top up 1 batch' }));
    const dialog = within(await screen.findByRole('dialog'));
    const views = viewsOf(fetchMock);
    fireEvent.click(dialog.getByRole('button', { name: 'Top up' }));
    expect(await dialog.findByText(EARLIER_STAMP_OPERATIONS_SETTLING)).toBeInTheDocument();
    await waitFor(() => expect(viewsOf(fetchMock)).toBe(views + 1));

    answer = jsonError(422, { error: 'stamp_refused', message: 'The batch is at depth 21 now, not 20.' });
    fireEvent.click(dialog.getByRole('button', { name: 'Top up' }));
    expect(await dialog.findByText('The batch is at depth 21 now, not 20.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('a stamp bulk still open', () => {
  it('is followed after a reload, read at once, and holds a new one until it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let open: string | null = BULK;
    let item = makeStampItem({ txHash: TX_HASH });
    const fetchMock = serve(
      () => makeStampView({ openStampBulkId: open }),
      [{ path: STAMPS, respond: () => jsonOk({ items: [item] }) }],
    );
    await openStamps();

    const progress = within(await screen.findByRole('table', { name: 'Stamp operations sent' }));
    expect(await progress.findByText('Sent')).toBeInTheDocument();
    expect(progress.getByText('catalogue-node')).toBeInTheDocument();
    expect(progress.getByText('0xaaaaaa…aaaaaa')).toBeInTheDocument();
    expect(pollsOf(fetchMock)).toBe(1);
    expect(fetchMock.mock.calls.find(([url]) => String(url).startsWith(`${STAMPS}?`))?.[0]).toBe(
      `${STAMPS}?bulkId=${BULK}`,
    );
    tick('catalogue-node');
    expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeDisabled();
    expect(screen.getByText(WAIT)).toBeInTheDocument();

    item = { ...item, state: 'confirmed', settled: true };
    open = null;
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));
    expect(await screen.findByText('Done: the stamp operation is confirmed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Top up 1 batch' })).toBeEnabled());
  });

  it('says of an operation not known yet that a new one waits, and of one settled so, to check the batch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let item = makeStampItem({ state: 'unknown', txHash: TX_HASH, settled: false, watched: true });
    const fetchMock = serve(
      () => makeStampView({ openStampBulkId: BULK }),
      [{ path: STAMPS, respond: () => jsonOk({ items: [item] }) }],
    );
    await openStamps();

    const progress = within(await screen.findByRole('table', { name: 'Stamp operations sent' }));
    expect(await progress.findByText(STAMP_NOT_KNOWN_YET_NOTE)).toBeInTheDocument();
    expect(progress.getByText('Not known yet')).toBeInTheDocument();

    item = { ...item, settled: true };
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));
    expect(await progress.findByText(STAMP_DROPPED_NOTE)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Done: 0 confirmed, 1 not known. This page still reads the one that may yet go through, every few seconds.',
      ),
    ).toBeInTheDocument();

    // Watched for ten minutes, then the page stops and offers Check again.
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_LIMIT_MS));
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument();
    const stoppedAt = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS * 3));
    expect(pollsOf(fetchMock)).toBe(stoppedAt);
  });
});
