import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FundingChequebookItem, FundingView } from '@streaming-monorepo/web2-admin-common';

import { EARLIER_CHEQUEBOOK_OPERATIONS_SETTLING } from '../api';
import { EXPLORER_TX_URL } from '../components/funding/balance';
import { BULK_POLL_LIMIT_MS, BULK_POLL_MS } from '../components/funding/BulkProgress';
import {
  atTargetText,
  BUSY_NODE_NOTE,
  PAYS_NOTE,
  readChequebooksAgainFailed,
  READING_CHEQUEBOOKS_AGAIN,
  WORKED_OUT_AGAIN_NOTE,
} from '../components/funding/ChequebookDialog';
import {
  CHEQUEBOOK_DROPPED_NOTE,
  CHEQUEBOOK_NOT_KNOWN_YET_NOTE,
  CHEQUEBOOK_READ_AGAIN_NOTE,
} from '../components/funding/ChequebookProgress';
import {
  CHEQUEBOOK_UNREAD_TEXT,
  GATEWAY_TEXT,
  MINUS,
  NO_CHEQUEBOOK_IN_STAGE,
  NO_CHEQUEBOOKS_REPORTED,
  NOTHING_TICKED_PROBLEM,
  NOTHING_TO_CHANGE_PROBLEM,
  TARGET_CAPTION,
  TARGET_EMPTY_PROBLEM,
  TARGET_FLOOR_TEXT,
  TARGET_TOO_LARGE_PROBLEM,
  TARGET_UNDER_FLOOR_PROBLEM,
  WALLET_UNREAD_TEXT,
} from '../components/funding/chequebooks';
import { NO_STAGES, WAIT_FOR_CHEQUEBOOKS } from '../components/funding/ChequebooksTab';
import { FundingPage } from '../pages/FundingPage';
import {
  makeChequebook,
  makeChequebookItem,
  makeChequebookView,
  makeNode,
  makeView,
  OVER_TARGET,
  unreadChequebook,
  xbzz,
} from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';

const FUNDING = '/api/funding';
const CHEQUEBOOKS = '/api/funding/chequebook-operations';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BULK = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';

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

/** How many times the page read a chequebook bulk, and how many times the view. */
const pollsOf = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${CHEQUEBOOKS}?`)).length;
const viewsOf = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === FUNDING).length;

/** The Funding page on its Chequebooks tab, once its first stage is drawn. */
async function openChequebooks() {
  renderWithProviders(<FundingPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Chequebooks' }));
  await screen.findByRole('heading', { name: 'Main stage' });
}

const table = (stage: string) => within(screen.getByRole('table', { name: `Chequebooks of ${stage}` }));
const rowOf = (stage: string, text: string) => within(table(stage).getByText(text).closest('tr') as HTMLElement);
const tick = (label: string) =>
  fireEvent.click(screen.getByRole('checkbox', { name: `Bring the chequebook of ${label} to the target` }));
const typeTarget = (value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Target' }), { target: { value } });

/** The bar's line of what Apply would do, by its whole text, the totals' own elements and all. */
const summary = (text: string) =>
  screen.getByText((_content, element) => element?.tagName === 'P' && element.textContent === text);

/** Opens the confirm dialog with Apply, and answers it once the view it reads again as it opens is back. */
async function openDialog(title?: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  const dialog = within(await screen.findByRole('dialog', title ? { name: title } : {}));
  await waitFor(() => expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled());
  return dialog;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the chequebooks', () => {
  it("lists each stage's chequebooks under its name, every digit of each balance, and no catalogue node", async () => {
    serve(() => makeChequebookView());
    await openChequebooks();

    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Main stage',
      'Second stage',
      'Third stage',
    ]);
    expect(screen.getByText(/^Chequebooks as the manager read them/)).toBeInTheDocument();
    expect(screen.queryByText('catalogue-node')).not.toBeInTheDocument();
    expect(
      table('Main stage')
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['', 'Node', 'Chequebook', 'Wallet', 'Move', 'Wallet after']);

    // The node's card, its chequebook exactly, and its wallet to three decimals with the exact amount on hover.
    const uploader = rowOf('Main stage', 'stage-1-uploader');
    expect(uploader.getByText('Main stage · uploader')).toBeInTheDocument();
    expect(uploader.getByText('Confirmed')).toBeInTheDocument();
    expect(uploader.getByText('Available')).toBeInTheDocument();
    expect(uploader.getByText('1.5 xBZZ')).toBeInTheDocument();
    expect(uploader.getByText('Total')).toBeInTheDocument();
    expect(uploader.getByText('2 xBZZ')).toBeInTheDocument();
    expect(uploader.getByText('Uncashed')).toBeInTheDocument();
    expect(uploader.getByText('0.5 xBZZ')).toBeInTheDocument();
    expect(uploader.getByText('5.000 xBZZ')).toHaveAttribute('title', '5 xBZZ');
    expect(uploader.getByText('0.200 xDAI')).toHaveAttribute('title', '0.2 xDAI');
    expect(uploader.getByRole('checkbox')).not.toBeChecked();

    const over = rowOf('Main stage', 'rung-720p');
    expect(over.getAllByText(`${OVER_TARGET} xBZZ`)).toHaveLength(2);
    expect(over.getByText('0 xBZZ')).toBeInTheDocument();

    // A node that has no chequebook has no row, and a stage with none says so.
    expect(screen.queryByText('rung-240p')).not.toBeInTheDocument();
    expect(screen.getByText(NO_CHEQUEBOOK_IN_STAGE)).toBeInTheDocument();
    expect(screen.queryByText('stage-3-uploader')).not.toBeInTheDocument();
    expect(screen.getByText(TARGET_FLOOR_TEXT)).toBeInTheDocument();
    expect(screen.getByText(TARGET_CAPTION)).toBeInTheDocument();
  });

  it("shows a gateway's chequebook read-only, and has no tick box for one not read or whose wallet was not read", async () => {
    serve(() => makeChequebookView());
    await openChequebooks();

    const gateway = rowOf('Main stage', 'stage-1-gateway');
    expect(gateway.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(gateway.getByText(GATEWAY_TEXT)).toBeInTheDocument();
    expect(gateway.getAllByText('1 xBZZ')).toHaveLength(2);

    const unread = rowOf('Main stage', 'rung-480p');
    expect(unread.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(unread.getByText('The node did not answer in time.')).toBeInTheDocument();
    expect(unread.getByText(CHEQUEBOOK_UNREAD_TEXT)).toBeInTheDocument();

    const noWallet = rowOf('Second stage', 'pool-360p');
    expect(noWallet.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(noWallet.getByText('Wallet not read')).toBeInTheDocument();
    expect(noWallet.getByText(WALLET_UNREAD_TEXT)).toBeInTheDocument();
    expect(noWallet.getAllByText('1 xBZZ')).toHaveLength(2);
  });

  it('keeps the header row one line high, in fixed columns that fit the page and leave the node card its address line', async () => {
    serve(() => makeChequebookView());
    await openChequebooks();
    const main = screen.getByRole('table', { name: 'Chequebooks of Main stage' });
    const headers = () => within(main).getAllByRole('columnheader');
    const px = (element: HTMLElement, property: 'width' | 'minWidth') =>
      Number.parseFloat(getComputedStyle(element)[property]);
    const widthOf = (label: string) =>
      px(headers().find((header) => header.textContent === label) as HTMLElement, 'width');
    /** The widths of every column but the node's, which takes what the others leave. */
    const fixedWidths = () =>
      headers()
        .filter((header) => header.textContent !== 'Node')
        .map((header) => px(header, 'width'));
    /** The least width the node column keeps for the node's card. */
    const nodeLeast = 240;
    /** The console's page at its widest: a large container, 1200 pixels, less its two gutters of 24. */
    const pageWidth = 1152;
    /** A small cell's padding, 16 pixels either side, and the outlined table's border, 1 either side. */
    const padding = 32;
    const border = 2;
    /** What each column's content needs, as measured in a browser at the console's font. */
    const needs = { addressLine: 270, wallet: 74, move: 180, walletAfter: 113 };

    for (const header of headers()) expect(header, header.textContent ?? '').toHaveStyle({ whiteSpace: 'nowrap' });
    const fixed = fixedWidths().reduce((sum, width) => sum + width, 0);
    expect(px(main, 'minWidth')).toBeGreaterThanOrEqual(fixed + nodeLeast);
    expect(px(main, 'minWidth')).toBeLessThanOrEqual(pageWidth);
    // Every digit of a balance under 1000 xBZZ, beside its name, and a move's exact amount once it wraps.
    expect(widthOf('Chequebook')).toBeGreaterThanOrEqual(300);
    expect(widthOf('Move') - padding).toBeGreaterThanOrEqual(needs.move);
    expect(widthOf('Wallet') - padding).toBeGreaterThanOrEqual(needs.wallet);
    expect(widthOf('Wallet after') - padding).toBeGreaterThanOrEqual(needs.walletAfter);
    // On the console's page the node's card keeps its address line on one line beside a New address or Address
    // changed chip, so such a row is no taller than the others.
    expect(pageWidth - border - fixed - padding).toBeGreaterThanOrEqual(needs.addressLine);

    // Typing a target and ticking a row change no width.
    const before = fixedWidths();
    typeTarget('2');
    tick('stage-1-uploader');
    expect(rowOf('Main stage', 'stage-1-uploader').getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(fixedWidths()).toEqual(before);
    expect(px(main, 'minWidth')).toBeGreaterThanOrEqual(fixed + nodeLeast);
  });

  it('says when the manager reports no chequebooks, as one older than the tab does', async () => {
    serve(() => makeView());
    await openChequebooks();

    expect(screen.getByText(NO_CHEQUEBOOKS_REPORTED)).toBeInTheDocument();
    expect(screen.getAllByText(NO_CHEQUEBOOK_IN_STAGE)).toHaveLength(2);
  });

  it('says so when the manager reports no stage', async () => {
    serve(() => makeView({ stages: [] }));
    renderWithProviders(<FundingPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Chequebooks' }));

    expect(await screen.findByText(NO_STAGES)).toBeInTheDocument();
    expect(screen.queryByText(NO_CHEQUEBOOKS_REPORTED)).not.toBeInTheDocument();
  });
});

describe('the target', () => {
  it('takes digits and one dot only, and holds Apply with a sentence while it is empty, under 1 xBZZ or too large', async () => {
    serve(() => makeChequebookView());
    await openChequebooks();
    const field = screen.getByRole('textbox', { name: 'Target' });
    const apply = screen.getByRole('button', { name: 'Apply' });

    expect(field).toHaveValue('');
    expect(apply).toBeDisabled();
    expect(screen.getByText(TARGET_EMPTY_PROBLEM)).toBeInTheDocument();
    expect(screen.getByText(NOTHING_TICKED_PROBLEM)).toBeInTheDocument();
    expect(summary('To apply: 0 deposits; 0 withdrawals.')).toBeInTheDocument();

    // A character a number cannot hold never reaches the field.
    for (const typed of ['2a', '-1', '1,5', '1e3']) {
      typeTarget(typed);
      expect(field, typed).toHaveValue('');
    }
    typeTarget('1.5');
    typeTarget('1.5.');
    expect(field).toHaveValue('1.5');

    typeTarget('0.5');
    expect(screen.getByText(TARGET_UNDER_FLOOR_PROBLEM)).toBeInTheDocument();
    expect(field.closest('[title]')).toHaveAttribute('title', TARGET_UNDER_FLOOR_PROBLEM);
    expect(screen.queryByText(TARGET_EMPTY_PROBLEM)).not.toBeInTheDocument();

    tick('stage-1-uploader');
    const uploader = rowOf('Main stage', 'stage-1-uploader');
    expect(uploader.getAllByText('—')).toHaveLength(2);
    expect(apply).toBeDisabled();

    typeTarget('2');
    expect(screen.queryByText(TARGET_UNDER_FLOOR_PROBLEM)).not.toBeInTheDocument();
    expect(field.closest('[title]')).toBeNull();
    expect(uploader.getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(apply).toBeEnabled();

    // 31 digits of PLUR, one more than the API takes.
    typeTarget(`1${'0'.repeat(14)}`);
    expect(screen.getByText(TARGET_TOO_LARGE_PROBLEM)).toBeInTheDocument();
    expect(field.closest('[title]')).toHaveAttribute('title', TARGET_TOO_LARGE_PROBLEM);
    expect(uploader.getAllByText('—')).toHaveLength(2);
    expect(apply).toBeDisabled();
  });

  it('holds Apply while nothing ticked would change', async () => {
    serve(() => makeChequebookView());
    await openChequebooks();

    typeTarget('2');
    tick('rung-1080p');
    const at = rowOf('Main stage', 'rung-1080p');
    expect(at.getByText('no change')).toBeInTheDocument();
    expect(at.getAllByText('—')).toHaveLength(1);
    expect(screen.getByText(NOTHING_TO_CHANGE_PROBLEM)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    tick('rung-1080p');
    expect(screen.getByText(NOTHING_TICKED_PROBLEM)).toBeInTheDocument();
  });
});

describe('the moves', () => {
  it("shows each ticked chequebook's move, every digit of it, its node's xBZZ after, and what Apply would do", async () => {
    serve(() => makeChequebookView());
    await openChequebooks();
    typeTarget('2');
    const under = rowOf('Main stage', 'stage-1-uploader');
    const over = rowOf('Main stage', 'rung-720p');
    const at = rowOf('Main stage', 'rung-1080p');
    expect(under.getAllByText('—')).toHaveLength(2);

    tick('stage-1-uploader');
    tick('rung-720p');
    tick('rung-1080p');
    expect(under.getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(under.getByText('4.500 xBZZ')).toHaveAttribute('title', '4.5 xBZZ');
    expect(over.getByText(`withdraw ${MINUS}1.2500000000000001 xBZZ`)).toBeInTheDocument();
    expect(over.getByText('6.250 xBZZ')).toHaveAttribute('title', '6.2500000000000001 xBZZ');
    expect(at.getByText('no change')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Fund/ })).not.toBeInTheDocument();

    // The totals to three decimals, with the exact amount on hover.
    const line = within(summary(`To apply: 1 deposit, +0.500 xBZZ; 1 withdrawal, ${MINUS}1.250 xBZZ.`));
    expect(line.getByText('+0.500 xBZZ')).toHaveAttribute('title', '+0.5 xBZZ');
    expect(line.getByText(`${MINUS}1.250 xBZZ`)).toHaveAttribute('title', `${MINUS}1.2500000000000001 xBZZ`);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();

    typeTarget('3');
    expect(under.getByText('deposit +1.5 xBZZ')).toBeInTheDocument();
    expect(over.getByText(`withdraw ${MINUS}0.2500000000000001 xBZZ`)).toBeInTheDocument();
    expect(at.getByText('deposit +1 xBZZ')).toBeInTheDocument();
    expect(summary(`To apply: 2 deposits, +2.500 xBZZ; 1 withdrawal, ${MINUS}0.250 xBZZ.`)).toBeInTheDocument();

    tick('rung-720p');
    expect(over.queryByText(/withdraw/)).not.toBeInTheDocument();
    expect(over.getAllByText('—')).toHaveLength(2);
  });

  it('shows a node short of xBZZ for its deposit in red, and Fund all opens the Balance tab with it entered', async () => {
    serve(() => makeChequebookView());
    await openChequebooks();

    typeTarget('7.0004');
    tick('stage-1-uploader');
    const row = rowOf('Main stage', 'stage-1-uploader');
    expect(row.getByText('deposit +5.5004 xBZZ')).toBeInTheDocument();
    expect(row.getByText('Short 0.501 xBZZ')).toHaveAttribute('title', '0.5004 xBZZ short');
    expect(row.queryByRole('button', { name: /Fund/ })).not.toBeInTheDocument();
    expect(screen.getByText('stage-1-uploader is short of 0.501 xBZZ for its deposit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Fund all' }));
    expect(screen.getByRole('tab', { name: 'Balance', selected: true })).toBeInTheDocument();
    const field = await screen.findByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' });
    expect(field).toHaveValue('0.501');
    expect(field).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'xDAI to send to stage-1-uploader' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Send to stage-1-uploader' })).toBeChecked();

    // Back on the Chequebooks tab, the target and the tick are as they were.
    fireEvent.click(screen.getByRole('tab', { name: 'Chequebooks' }));
    await screen.findByRole('heading', { name: 'Main stage' });
    expect(screen.getByRole('textbox', { name: 'Target' })).toHaveValue('7.0004');
    expect(rowOf('Main stage', 'stage-1-uploader').getByRole('checkbox')).toBeChecked();
    expect(rowOf('Main stage', 'stage-1-uploader').getByText('Short 0.501 xBZZ')).toBeInTheDocument();
  });

  it('says a node holds no xDAI for the gas, and Fund all enters 0.01 xDAI for it on the Balance tab', async () => {
    const view = makeChequebookView();
    const [uploader, ...rest] = view.stages[0]?.nodes ?? [];
    if (view.stages[0] && uploader) view.stages[0].nodes = [{ ...uploader, xdaiWei: '0' }, ...rest];
    serve(() => view);
    await openChequebooks();

    typeTarget('2');
    tick('stage-1-uploader');
    const row = rowOf('Main stage', 'stage-1-uploader');
    expect(row.getByText('4.500 xBZZ')).toBeInTheDocument();
    expect(row.getByText('No xDAI for gas')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /Fund/ })).not.toBeInTheDocument();
    expect(screen.getByText('stage-1-uploader holds no xDAI to pay the gas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Fund all' }));
    const xdai = await screen.findByRole('textbox', { name: 'xDAI to send to stage-1-uploader' });
    expect(xdai).toHaveFocus();
    expect(xdai).toHaveValue('0.01');
    expect(screen.getByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Send to stage-1-uploader' })).toBeChecked();
  });

  it('funds every ticked node that lacks something at once, and none that lacks nothing', async () => {
    // The uploader cannot pay a deposit to 7 xBZZ; the rung over it holds no xDAI for its withdrawal.
    const view = makeChequebookView();
    const [uploader, rung, ...rest] = view.stages[0]?.nodes ?? [];
    if (view.stages[0] && uploader && rung) view.stages[0].nodes = [uploader, { ...rung, xdaiWei: '0' }, ...rest];
    serve(() => view);
    await openChequebooks();

    typeTarget('2');
    tick('rung-1080p');
    // At the target, nothing moves, so nothing is lacking and there is nothing to fund.
    expect(screen.queryByRole('button', { name: 'Fund all' })).not.toBeInTheDocument();
    tick('rung-720p');
    expect(screen.getByRole('button', { name: 'Fund all' })).toBeInTheDocument();
    typeTarget('7');
    tick('stage-1-uploader');
    expect(rowOf('Main stage', 'stage-1-uploader').getByText('Short 0.500 xBZZ')).toBeInTheDocument();
    expect(rowOf('Main stage', 'rung-720p').getByText('No xDAI for gas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fund all' }));
    // The first node the tab lists takes the focus.
    const xbzzField = await screen.findByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' });
    expect(xbzzField).toHaveValue('0.5');
    expect(xbzzField).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'xDAI to send to rung-720p' })).toHaveValue('0.01');
    expect(screen.getByRole('textbox', { name: 'xBZZ to send to rung-720p' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Send to rung-720p' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Send to rung-1080p' })).not.toBeChecked();
  });

  it('ticks a chequebook two stages share in both places, and asks for it once', async () => {
    const shared = makeNode({ nodeId: 'pool:720p', label: 'shared-720p', role: 'rung', chequebook: makeChequebook() });
    const view = makeChequebookView();
    view.stages[0]?.nodes.push(shared);
    view.stages[1]?.nodes.push(shared);
    const sent = makeChequebookItem({ nodeId: 'pool:720p', nodeLabel: 'shared-720p' });
    const fetchMock = serve(
      () => view,
      [
        { path: CHEQUEBOOKS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: [sent] }, 202) },
        { path: CHEQUEBOOKS, respond: () => jsonOk({ items: [sent] }) },
      ],
    );
    await openChequebooks();

    const boxes = () => screen.getAllByRole('checkbox', { name: 'Bring the chequebook of shared-720p to the target' });
    expect(boxes()).toHaveLength(2);
    fireEvent.click(boxes()[1] as HTMLElement);
    expect(boxes().map((box) => (box as HTMLInputElement).checked)).toEqual([true, true]);
    typeTarget('2');
    expect(summary('To apply: 1 deposit, +0.500 xBZZ; 0 withdrawals.')).toBeInTheDocument();

    const dialog = await openDialog('Bring 1 chequebook to 2 xBZZ?');
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, CHEQUEBOOKS)).toEqual({
        targetPlur: xbzz('2'),
        items: [{ nodeId: 'pool:720p', availablePlur: xbzz('1.5') }],
      }),
    );
  });
});

describe('applying', () => {
  it('confirms each move with no password, then follows each until it is confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let confirmed = false;
    const items = (): FundingChequebookItem[] => [
      makeChequebookItem({
        txHash: confirmed ? TX_HASH : null,
        state: confirmed ? 'confirmed' : 'submitted',
        settled: confirmed,
      }),
      makeChequebookItem({
        requestId: 'chequebook-request-2',
        nodeId: 'stage-1:720p',
        nodeLabel: 'rung-720p',
        direction: 'withdraw',
        amountPlur: '12500000000000001',
        state: confirmed ? 'confirmed' : 'queued',
        settled: confirmed,
      }),
    ];
    const fetchMock = serve(
      () => makeChequebookView(),
      [
        { path: CHEQUEBOOKS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: items() }, 202) },
        { path: CHEQUEBOOKS, respond: () => jsonOk({ items: items() }) },
      ],
    );
    await openChequebooks();

    typeTarget('2');
    tick('stage-1-uploader');
    tick('rung-720p');
    tick('rung-1080p');
    const dialog = await openDialog('Bring 2 chequebooks to 2 xBZZ?');
    const asked = within(dialog.getByRole('table', { name: 'Chequebook operations to ask for' }));
    expect(asked.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Node',
      'Move',
      'Available now',
      'Available after',
    ]);
    const deposit = within(asked.getByText('stage-1-uploader').closest('tr') as HTMLElement);
    expect(deposit.getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(deposit.getByText('1.5 xBZZ')).toBeInTheDocument();
    expect(deposit.getByText('2 xBZZ')).toBeInTheDocument();
    const withdrawal = within(asked.getByText('rung-720p').closest('tr') as HTMLElement);
    expect(withdrawal.getByText(`withdraw ${MINUS}1.2500000000000001 xBZZ`)).toBeInTheDocument();
    expect(withdrawal.getByText(`${OVER_TARGET} xBZZ`)).toBeInTheDocument();
    expect(withdrawal.getByText('2 xBZZ')).toBeInTheDocument();
    // The one at the target is not asked for, and the dialog says so.
    expect(asked.queryByText('rung-1080p')).not.toBeInTheDocument();
    expect(dialog.getByText(atTargetText(1))).toBeInTheDocument();
    expect(dialog.getByText(PAYS_NOTE)).toBeInTheDocument();
    expect(dialog.getByText(WORKED_OUT_AGAIN_NOTE)).toBeInTheDocument();
    expect(WORKED_OUT_AGAIN_NOTE).toBe(
      'Each move is worked out again from the balance read when it is sent, and never moves more than listed here.',
    );
    expect(dialog.getByText(BUSY_NODE_NOTE)).toBeInTheDocument();
    expect(dialog.queryByLabelText('Your password')).not.toBeInTheDocument();

    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('heading', { name: 'Chequebook operations' })).toBeInTheDocument();
    expect(bodyOf(fetchMock, CHEQUEBOOKS)).toEqual({
      targetPlur: xbzz('2'),
      items: [
        { nodeId: 'stage-1:bee', availablePlur: xbzz('1.5') },
        { nodeId: 'stage-1:720p', availablePlur: xbzz(OVER_TARGET) },
      ],
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Bring the chequebook of stage-1-uploader to the target' }),
    ).not.toBeChecked();
    const progress = within(screen.getByRole('table', { name: 'Chequebook operations sent' }));
    expect(progress.getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(progress.getByText(`withdraw ${MINUS}1.2500000000000001 xBZZ`)).toBeInTheDocument();
    expect(progress.getByText('Sent')).toBeInTheDocument();
    expect(progress.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 done. This page reads them again every few seconds.')).toBeInTheDocument();
    expect(screen.getByText(CHEQUEBOOK_READ_AGAIN_NOTE)).toBeInTheDocument();

    // A new chequebook bulk waits for this one, and the target stays.
    expect(screen.getByRole('textbox', { name: 'Target' })).toHaveValue('2');
    tick('stage-1-uploader');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByText(WAIT_FOR_CHEQUEBOOKS)).toBeInTheDocument();

    const views = viewsOf(fetchMock);
    confirmed = true;
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));
    expect(await screen.findByText('Done: all 2 chequebook operations are confirmed.')).toBeInTheDocument();
    expect(progress.getByRole('link', { name: /0xabababab/ })).toHaveAttribute('href', `${EXPLORER_TX_URL}${TX_HASH}`);
    // Settled, so the view is read again and a new chequebook bulk may go.
    await waitFor(() => expect(viewsOf(fetchMock)).toBeGreaterThan(views));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.queryByText(WAIT_FOR_CHEQUEBOOKS)).not.toBeInTheDocument();

    const ended = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS * 3));
    expect(pollsOf(fetchMock)).toBe(ended);
  });

  it('follows the moves the API journalled, which may be less than the dialog listed', async () => {
    // Since the page read them, the uploader's chequebook grew and the rung's drew down: each moves less than listed.
    const journalled = [
      makeChequebookItem({ amountPlur: xbzz('0.25') }),
      makeChequebookItem({
        requestId: 'chequebook-request-2',
        nodeId: 'stage-1:720p',
        nodeLabel: 'rung-720p',
        direction: 'withdraw',
        amountPlur: xbzz('1'),
        state: 'queued',
      }),
    ];
    serve(
      () => makeChequebookView(),
      [
        { path: CHEQUEBOOKS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: journalled }, 202) },
        { path: CHEQUEBOOKS, respond: () => jsonOk({ items: journalled }) },
      ],
    );
    await openChequebooks();
    typeTarget('2');
    tick('stage-1-uploader');
    tick('rung-720p');

    const dialog = await openDialog('Bring 2 chequebooks to 2 xBZZ?');
    const asked = within(dialog.getByRole('table', { name: 'Chequebook operations to ask for' }));
    expect(asked.getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(asked.getByText(`withdraw ${MINUS}1.2500000000000001 xBZZ`)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));

    const progress = within(await screen.findByRole('table', { name: 'Chequebook operations sent' }));
    expect(progress.getByText('deposit +0.25 xBZZ')).toBeInTheDocument();
    expect(progress.getByText(`withdraw ${MINUS}1 xBZZ`)).toBeInTheDocument();
    expect(progress.queryByText('deposit +0.5 xBZZ')).not.toBeInTheDocument();
    expect(progress.queryByText(`withdraw ${MINUS}1.2500000000000001 xBZZ`)).not.toBeInTheDocument();
  });

  it('says in the dialog why it was refused, an earlier bulk still settling in its own words, and reads the view again', async () => {
    let answer = jsonError(409, { error: 'conflict' });
    const fetchMock = serve(() => makeChequebookView(), [{ path: CHEQUEBOOKS, method: 'POST', respond: () => answer }]);
    await openChequebooks();

    typeTarget('2');
    tick('stage-1-uploader');
    const views = viewsOf(fetchMock);
    const dialog = await openDialog();
    expect(viewsOf(fetchMock)).toBe(views + 1);
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    expect(await dialog.findByText(EARLIER_CHEQUEBOOK_OPERATIONS_SETTLING)).toBeInTheDocument();
    await waitFor(() => expect(viewsOf(fetchMock)).toBe(views + 2));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled());

    const refused =
      'The chequebook of stage-1-uploader (stage-1:bee) holds 2 xBZZ available now, at the target or past it, so there is nothing to move. Read the page again. Nothing was sent.';
    answer = jsonError(409, { error: 'funding_refused', message: refused });
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    expect(await dialog.findByText(refused)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('reads the view again as the dialog opens, and lists and asks for the moves that reading shows', async () => {
    let view = makeChequebookView();
    let held: Promise<void> | null = null;
    const fetchMock = mockFetch([
      {
        path: FUNDING,
        respond: async () => {
          const answer = view;
          if (held) await held;
          return jsonOk(answer);
        },
      },
      {
        path: CHEQUEBOOKS,
        method: 'POST',
        respond: () => jsonOk({ bulkId: BULK, items: [makeChequebookItem({ amountPlur: xbzz('0.75') })] }, 202),
      },
      { path: CHEQUEBOOKS, respond: () => jsonOk({ items: [makeChequebookItem({ amountPlur: xbzz('0.75') })] }) },
    ]);
    await openChequebooks();
    typeTarget('2');
    tick('stage-1-uploader');
    expect(rowOf('Main stage', 'stage-1-uploader').getByText('deposit +0.5 xBZZ')).toBeInTheDocument();

    // The node has paid its peers since the page read it, and the dialog's reading answers only when let go.
    const [uploader, ...rest] = view.stages[0]?.nodes ?? [];
    view = makeChequebookView();
    if (view.stages[0] && uploader) {
      view.stages[0].nodes = [{ ...uploader, chequebook: makeChequebook({ availablePlur: xbzz('1.25') }) }, ...rest];
    }
    let letGo!: () => void;
    held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const views = viewsOf(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(viewsOf(fetchMock)).toBe(views + 1);
    expect(dialog.getByText(READING_CHEQUEBOOKS_AGAIN)).toBeInTheDocument();
    expect(dialog.queryByRole('table')).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();

    await act(async () => {
      letGo();
      await held;
    });
    const asked = within(await dialog.findByRole('table', { name: 'Chequebook operations to ask for' }));
    expect(asked.getByText('deposit +0.75 xBZZ')).toBeInTheDocument();
    expect(asked.getByText('1.25 xBZZ')).toBeInTheDocument();
    expect(dialog.queryByText(READING_CHEQUEBOOKS_AGAIN)).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled();

    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, CHEQUEBOOKS)).toEqual({
        targetPlur: xbzz('2'),
        items: [{ nodeId: 'stage-1:bee', availablePlur: xbzz('1.25') }],
      }),
    );
  });

  it('asks for nothing while the view cannot be read again, and says why in the dialog', async () => {
    let failing = false;
    const fetchMock = serve(
      () => (failing ? jsonError(404, { error: 'not_found' }) : makeChequebookView()),
      [
        {
          path: CHEQUEBOOKS,
          method: 'POST',
          respond: () => jsonOk({ bulkId: BULK, items: [makeChequebookItem()] }, 202),
        },
      ],
    );
    await openChequebooks();
    typeTarget('2');
    tick('stage-1-uploader');

    failing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Bring 1 chequebook to 2 xBZZ?' }));

    expect(await dialog.findByText(readChequebooksAgainFailed('Not found.'))).toBeInTheDocument();
    expect(dialog.queryByRole('table')).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === CHEQUEBOOKS && init?.method === 'POST')).toBe(
      false,
    );
  });
});

describe('the selection, while the page stays open', () => {
  /** Shows another tab, then the Chequebooks tab again, once its first stage is drawn. */
  async function away(to: 'Balance' | 'Stamps') {
    fireEvent.click(screen.getByRole('tab', { name: to }));
    await screen.findAllByRole('heading', { level: 3 });
    fireEvent.click(screen.getByRole('tab', { name: 'Chequebooks' }));
    await screen.findByRole('heading', { name: 'Main stage' });
  }

  it('keeps the target and the ticks while another tab is shown', async () => {
    serve(() => makeChequebookView());
    await openChequebooks();
    typeTarget('2');
    tick('stage-1-uploader');
    tick('rung-720p');

    await away('Balance');
    await away('Stamps');
    expect(screen.getByRole('textbox', { name: 'Target' })).toHaveValue('2');
    expect(rowOf('Main stage', 'stage-1-uploader').getByRole('checkbox')).toBeChecked();
    expect(rowOf('Main stage', 'rung-720p').getByRole('checkbox')).toBeChecked();
    expect(summary(`To apply: 1 deposit, +0.500 xBZZ; 1 withdrawal, ${MINUS}1.250 xBZZ.`)).toBeInTheDocument();
  });

  it('reads the chequebooks again as it is shown, and neither counts nor asks for a tick left on one now unread', async () => {
    let view = makeChequebookView();
    const sent = makeChequebookItem();
    const fetchMock = serve(
      () => view,
      [
        { path: CHEQUEBOOKS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: [sent] }, 202) },
        { path: CHEQUEBOOKS, respond: () => jsonOk({ items: [sent] }) },
      ],
    );
    await openChequebooks();
    typeTarget('2');
    tick('stage-1-uploader');
    tick('rung-720p');

    // The rung's node does not answer about its chequebook the next time the view is read.
    view = makeChequebookView();
    const [uploader, rung, ...rest] = view.stages[0]?.nodes ?? [];
    if (view.stages[0] && uploader && rung)
      view.stages[0].nodes = [uploader, { ...rung, chequebook: unreadChequebook() }, ...rest];
    const reads = viewsOf(fetchMock);
    await away('Balance');
    expect(viewsOf(fetchMock)).toBe(reads + 2);
    expect(rowOf('Main stage', 'rung-720p').queryByRole('checkbox')).not.toBeInTheDocument();
    expect(rowOf('Main stage', 'rung-720p').getByText(CHEQUEBOOK_UNREAD_TEXT)).toBeInTheDocument();
    expect(summary('To apply: 1 deposit, +0.500 xBZZ; 0 withdrawals.')).toBeInTheDocument();

    const dialog = await openDialog('Bring 1 chequebook to 2 xBZZ?');
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, CHEQUEBOOKS)).toEqual({
        targetPlur: xbzz('2'),
        items: [{ nodeId: 'stage-1:bee', availablePlur: xbzz('1.5') }],
      }),
    );
  });
});

describe('a chequebook bulk still open', () => {
  it('is followed after a reload, read at once, and holds a new one until it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let open: string | null = BULK;
    let item = makeChequebookItem({ txHash: TX_HASH });
    const fetchMock = serve(
      () => makeChequebookView({ openChequebookBulkId: open }),
      [{ path: CHEQUEBOOKS, respond: () => jsonOk({ items: [item] }) }],
    );
    await openChequebooks();

    const progress = within(await screen.findByRole('table', { name: 'Chequebook operations sent' }));
    expect(await progress.findByText('Sent')).toBeInTheDocument();
    expect(progress.getByText('stage-1-uploader')).toBeInTheDocument();
    expect(progress.getByText('deposit +0.5 xBZZ')).toBeInTheDocument();
    expect(pollsOf(fetchMock)).toBe(1);
    expect(fetchMock.mock.calls.find(([url]) => String(url).startsWith(`${CHEQUEBOOKS}?`))?.[0]).toBe(
      `${CHEQUEBOOKS}?bulkId=${BULK}`,
    );
    typeTarget('2');
    tick('stage-1-uploader');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByText(WAIT_FOR_CHEQUEBOOKS)).toBeInTheDocument();

    item = { ...item, state: 'confirmed', settled: true };
    open = null;
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));
    expect(await screen.findByText('Done: the chequebook operation is confirmed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled());
  });

  it('says of an operation not known yet that a new one waits, and of one settled so, to check the chequebook', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let item = makeChequebookItem({ state: 'unknown', txHash: TX_HASH, settled: false, watched: true });
    const fetchMock = serve(
      () => makeChequebookView({ openChequebookBulkId: BULK }),
      [{ path: CHEQUEBOOKS, respond: () => jsonOk({ items: [item] }) }],
    );
    await openChequebooks();

    const progress = within(await screen.findByRole('table', { name: 'Chequebook operations sent' }));
    expect(await progress.findByText(CHEQUEBOOK_NOT_KNOWN_YET_NOTE)).toBeInTheDocument();
    expect(progress.getByText('Not known yet')).toBeInTheDocument();

    item = { ...item, settled: true };
    await act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));
    expect(await progress.findByText(CHEQUEBOOK_DROPPED_NOTE)).toBeInTheDocument();
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
