import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FundingTransferItem } from '@streaming-monorepo/web2-admin-common';

import { EARLIER_SEND_SETTLING } from '../api';
import { EXPLORER_TX_URL } from '../components/funding/balance';
import { FEE_NOTE } from '../components/funding/SendDialog';
import {
  DROPPED_NOTE,
  NOT_KNOWN_YET_NOTE,
  TRANSFER_POLL_LIMIT_MS,
  TRANSFER_POLL_MS,
} from '../components/funding/TransferProgress';
import { FUND_IT_TEXT } from '../components/funding/WalletCard';
import { setUnauthorizedHandler } from '../http';
import { COMING_NEXT, FundingPage } from '../pages/FundingPage';
import { makeItem, makeNode, makeView, WALLET } from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';

const FUNDING = '/api/funding';
const PINS = '/api/funding/pins';
const TRANSFERS = '/api/funding/transfers';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_TX_HASH = `0x${'cd'.repeat(32)}`;
const WAIT = 'Wait for the transfers above to finish.';

/** The admin's sentences: a transfer the chain's node refused at the relay, one reverted in a block, one dropped. */
const REFUSED_AT_RELAY =
  "The chain's node refused it when the manager sent it. If it is mined anyway, this row will say so: check the node's balance before sending to it again.";
const REVERTED = 'The transaction reverted on chain.';
const DROPPED = 'The chain has no receipt for it and no longer holds it.';

type View = ReturnType<typeof makeView>;

/** The funding view, answered from a getter so a test can change it between two reads. */
function serve(view: () => View | Response, extra: Route[] = []) {
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

const tick = (label: string) => fireEvent.click(screen.getByRole('checkbox', { name: `Send to ${label}` }));
const type = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });

/** How many times the page read a bulk's transfers. */
const pollsOf = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${TRANSFERS}?`)).length;

/** Ticks the stage's uploader with 0.1 xDAI: a send Send takes unless an earlier one holds it back. */
function enterAnotherSend() {
  tick('stage-1-uploader');
  type('xDAI to send to stage-1-uploader', '0.1');
}

afterEach(() => {
  vi.useRealTimers();
  setUnauthorizedHandler(null);
});

/** Ticks the stage's uploader with 0.1 xDAI, opens the send dialog and types the password, and answers the dialog. */
async function openSend() {
  await screen.findByRole('heading', { name: 'Brand wallet' });
  tick('stage-1-uploader');
  type('xDAI to send to stage-1-uploader', '0.1');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'operator-password' } });
  return dialog;
}

describe('the Funding page', () => {
  it('has a Balance tab, and says the Stamps and Chequebooks tabs come next', async () => {
    serve(() => makeView());
    renderWithProviders(<FundingPage />);

    expect(screen.getByRole('heading', { name: 'Funding' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Balance', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Brand wallet' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
    expect(screen.getByText(COMING_NEXT.stamps)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Chequebooks' }));
    expect(screen.getByText(COMING_NEXT.chequebooks)).toBeInTheDocument();
  });

  it('says it is not set up when the admin has no manager to fund through', async () => {
    serve(() => makeView({ configured: false, wallet: null, stages: [], catalogue: null }));
    renderWithProviders(<FundingPage />);

    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.getByText(/MANAGER_FUNDING_URL and MANAGER_FUNDING_TOKEN/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Brand wallet' })).not.toBeInTheDocument();
  });

  it("shows the API's error, and reads again on Retry", async () => {
    let answer: View | Response = jsonError(404, { error: 'not_found' });
    const fetchMock = serve(() => answer);
    renderWithProviders(<FundingPage />);

    expect(await screen.findByText('Not found.')).toBeInTheDocument();
    answer = makeView();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Brand wallet' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === FUNDING)).toHaveLength(2);
  });

  it('says what the manager answered when it could not be read', async () => {
    serve(() => makeView({ managerError: 'The manager did not answer in time.', stages: [], catalogue: null }));
    renderWithProviders(<FundingPage />);

    expect(await screen.findByText(/The manager did not answer: The manager did not answer in time\./)).toBeVisible();
  });
});

describe('the brand wallet', () => {
  it('shows its address with a copy button and a QR code, its balances, and where to fund it from, with no link', async () => {
    serve(() => makeView());
    renderWithProviders(<FundingPage />);

    expect(await screen.findByText(WALLET)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'copy wallet address' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'QR code of the wallet address' })).toBeInTheDocument();
    expect(screen.getByText('1.5 xDAI')).toBeInTheDocument();
    expect(screen.getByText('12.5 xBZZ')).toBeInTheDocument();
    expect(screen.getByText(FUND_IT_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Multichain/ })).not.toBeInTheDocument();
  });

  it('says how one comes to exist while there is none', async () => {
    serve(() => makeView({ wallet: null }));
    renderWithProviders(<FundingPage />);

    expect(await screen.findByText(/BRAND_WALLET_SECRET/)).toBeInTheDocument();
  });
});

describe('the nodes', () => {
  it('lists the catalogue node on top, then each stage, with balances, roles, read errors and address checks', async () => {
    const view = makeView();
    view.stages[0]?.nodes.push(
      makeNode({
        nodeId: 'stage-1:moved',
        label: 'moved-node',
        walletAddress: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
        pin: 'changed',
        pinnedAddress: '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      }),
      makeNode({
        nodeId: 'stage-1:unread',
        label: 'unread-node',
        role: 'gateway',
        walletAddress: null,
        xdaiWei: null,
        xbzzPlur: null,
        readError: 'The node did not answer.',
        pin: 'new',
        pinnedAddress: null,
      }),
    );
    serve(() => view);
    renderWithProviders(<FundingPage />);

    await screen.findByRole('heading', { name: 'Catalogue node' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Catalogue node',
      'Main stage',
      'Second stage',
    ]);

    const main = within(screen.getByRole('table', { name: 'Nodes of Main stage' }));
    const uploader = within(main.getByText('stage-1-uploader').closest('tr') as HTMLElement);
    expect(uploader.getByText('Main stage · uploader')).toBeInTheDocument();
    expect(uploader.getByText('0.200 xDAI')).toBeInTheDocument();
    expect(uploader.getByText('5.000 xBZZ')).toBeInTheDocument();
    expect(uploader.getByText('Confirmed')).toBeInTheDocument();

    const moved = within(main.getByText('moved-node').closest('tr') as HTMLElement);
    expect(moved.getByText('Address changed').closest('[title]')).toHaveAttribute(
      'title',
      'It was 0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
    );
    expect(moved.getByText('0x4f0e1c…0b0a09')).toBeInTheDocument();

    const unread = within(main.getByText('unread-node').closest('tr') as HTMLElement);
    expect(unread.getByText('The node did not answer.')).toBeInTheDocument();
    expect(unread.getByText('Wallet not read')).toBeInTheDocument();
    expect(unread.getByRole('checkbox', { name: 'Send to unread-node' })).toBeDisabled();

    expect(
      within(screen.getByRole('table', { name: 'Nodes of Second stage' })).getByText('New address'),
    ).toBeInTheDocument();
  });

  it('takes an amount beside each balance: typing ticks the node and shows what it will hold after', async () => {
    serve(() => makeView());
    renderWithProviders(<FundingPage />);
    await screen.findByRole('heading', { name: 'Brand wallet' });

    const box = screen.getByRole('checkbox', { name: 'Send to stage-1-uploader' });
    const row = within(box.closest('tr') as HTMLElement);
    expect(box).not.toBeChecked();

    type('xDAI to send to stage-1-uploader', '0.05');
    expect(box).toBeChecked();
    expect(row.getByText('0.250 xDAI')).toBeInTheDocument();

    type('xDAI to send to stage-1-uploader', '');
    expect(box).not.toBeChecked();

    type('xBZZ to send to stage-1-uploader', '1');
    expect(row.getByText('6.000 xBZZ')).toBeInTheDocument();
    tick('stage-1-uploader');
    expect(box).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' })).toHaveValue('');
  });

  it('confirms the new and changed addresses with the password, showing the old and the new address', async () => {
    const view = makeView();
    view.stages[0]?.nodes.push(
      makeNode({
        nodeId: 'stage-1:moved',
        label: 'moved-node',
        walletAddress: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
        pin: 'changed',
        pinnedAddress: '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      }),
    );
    let current = view;
    const fetchMock = serve(
      () => current,
      [
        {
          path: PINS,
          method: 'POST',
          respond: () => {
            current = makeView({
              stages: view.stages.map((stage) => ({
                ...stage,
                nodes: stage.nodes.map((node) => ({ ...node, pin: 'pinned' as const })),
              })),
            });
            return jsonOk({ pinned: ['stage-1:moved', 'stage-2:360p'] });
          },
        },
      ],
    );
    renderWithProviders(<FundingPage />);

    expect(await screen.findByText(/2 nodes have wallet addresses to confirm/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm addresses' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('was 0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3')).toBeInTheDocument();
    expect(dialog.getByText('now 0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09')).toBeInTheDocument();
    expect(dialog.getByText('0x2222222222222222222222222222222222222222')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Confirm addresses' })).toBeDisabled();

    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'operator-password' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Confirm addresses' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf(fetchMock, PINS)).toEqual({
      password: 'operator-password',
      nodeIds: ['stage-1:moved', 'stage-2:360p'],
    });
    await waitFor(() => expect(screen.queryByText(/to confirm before/)).not.toBeInTheDocument());
  });

  it('says a wrong password in the dialog, without signing the operator out', async () => {
    serve(
      () => makeView(),
      [{ path: PINS, method: 'POST', respond: () => jsonError(401, { error: 'invalid_credentials' }) }],
    );
    renderWithProviders(<FundingPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm addresses' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Confirm addresses' }));

    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('sending from the brand wallet', () => {
  it('holds Send until a confirmed node is ticked with an amount, and while the total is over the balance', async () => {
    serve(() => makeView());
    renderWithProviders(<FundingPage />);

    await screen.findByRole('heading', { name: 'Brand wallet' });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(screen.getByText('Enter an amount beside a node to send it.')).toBeInTheDocument();

    tick('stage-1-uploader');
    type('xDAI to send to stage-1-uploader', '0.5');
    expect(send).toBeEnabled();
    expect(screen.getByText(/0\.5 of 1\.5 xDAI/)).toBeInTheDocument();

    type('xDAI to send to stage-1-uploader', '2');
    expect(send).toBeDisabled();
    expect(screen.getByText('That is more xDAI than the brand wallet holds.')).toBeInTheDocument();

    type('xDAI to send to stage-1-uploader', '1.5');
    type('xBZZ to send to stage-1-uploader', '1,5');
    expect(screen.getByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' })).toHaveValue('');
    expect(send).toBeEnabled();

    type('xBZZ to send to stage-1-uploader', '.');
    expect(send).toBeDisabled();
    expect(
      screen.getByText('The xBZZ amount for stage-1-uploader: Digits and one dot only, such as 1.5.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'xBZZ to send to stage-1-uploader' }).closest('[title]'),
    ).toHaveAttribute('title', 'Digits and one dot only, such as 1.5.');

    type('xBZZ to send to stage-1-uploader', '');
    tick('pool-360p');
    type('xBZZ to send to pool-360p', '1');
    expect(send).toBeDisabled();
    expect(screen.getByText('Confirm the address of pool-360p before sending to it.')).toBeInTheDocument();
  });

  it('ticks a node shared by two stages wherever it is listed, takes its amount once and sends it once', async () => {
    const shared = makeNode({
      nodeId: 'pool:720p',
      label: 'shared-720p',
      role: 'rung',
      walletAddress: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
      pinnedAddress: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
    });
    const view = makeView();
    view.stages[0]?.nodes.push(shared);
    view.stages[1]?.nodes.push(shared);
    const fetchMock = serve(
      () => view,
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () => jsonOk({ bulkId: '9e6a3d5b-4f70-4b82-9dce-3f4a5b6c7d8e', items: [] }, 202),
        },
      ],
    );
    renderWithProviders(<FundingPage />);

    await screen.findByRole('heading', { name: 'Brand wallet' });
    const boxes = () => screen.getAllByRole('checkbox', { name: 'Send to shared-720p' });
    expect(boxes()).toHaveLength(2);
    fireEvent.click(boxes()[0] as HTMLElement);
    expect(boxes().map((box) => (box as HTMLInputElement).checked)).toEqual([true, true]);

    const fields = () => screen.getAllByRole('textbox', { name: 'xDAI to send to shared-720p' });
    fireEvent.change(fields()[1] as HTMLElement, { target: { value: '0.5' } });
    expect(fields().map((field) => (field as HTMLInputElement).value)).toEqual(['0.5', '0.5']);
    expect(screen.getByText(/0\.5 of 1\.5 xDAI/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Send 1 transfer from the brand wallet?' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'operator-password' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, TRANSFERS)).toEqual({
        password: 'operator-password',
        items: [{ nodeId: 'pool:720p', kind: 'xdai', amount: '500000000000000000' }],
      }),
    );
  });

  it('sends with the password, then follows each transfer until it is confirmed, with its transaction link', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: 'submitted' | 'confirmed' = 'submitted';
    const fetchMock = serve(
      () => makeView(),
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () =>
            jsonOk(
              {
                bulkId: '6b3f0a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b',
                items: [
                  {
                    requestId: 'request-1',
                    nodeId: 'stage-1:bee',
                    kind: 'xdai',
                    amount: '500000000000000000',
                    state: 'submitted',
                    settled: false,
                    watched: false,
                  },
                  {
                    requestId: 'request-2',
                    nodeId: 'catalogue:bee',
                    kind: 'xbzz',
                    amount: '25000000000000000',
                    state: 'submitted',
                    settled: false,
                    watched: false,
                  },
                ],
              },
              202,
            ),
        },
        {
          path: TRANSFERS,
          respond: () =>
            jsonOk({
              items: [
                {
                  requestId: 'request-1',
                  nodeId: 'stage-1:bee',
                  kind: 'xdai',
                  amount: '500000000000000000',
                  state,
                  txHash: TX_HASH,
                  blockNumber: state === 'confirmed' ? 1 : null,
                  error: null,
                  settled: state === 'confirmed',
                  watched: false,
                },
                {
                  requestId: 'request-2',
                  nodeId: 'catalogue:bee',
                  kind: 'xbzz',
                  amount: '25000000000000000',
                  state: 'failed',
                  txHash: OTHER_TX_HASH,
                  blockNumber: 7,
                  error: REVERTED,
                  settled: true,
                  watched: false,
                },
              ],
            }),
        },
      ],
    );
    renderWithProviders(<FundingPage />);

    await screen.findByRole('heading', { name: 'Brand wallet' });
    tick('stage-1-uploader');
    type('xDAI to send to stage-1-uploader', '0.5');
    tick('catalogue-node');
    type('xBZZ to send to catalogue-node', '2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Send 2 transfers from the brand wallet?' }));
    expect(dialog.getByText('stage-1-uploader')).toBeInTheDocument();
    expect(dialog.getByText('0.5 xDAI')).toBeInTheDocument();
    expect(dialog.getByText('2.5 xBZZ')).toBeInTheDocument();
    expect(dialog.getByText('In all: 0.5 xDAI and 2.5 xBZZ.')).toBeInTheDocument();
    expect(dialog.getByText(FEE_NOTE)).toBeInTheDocument();

    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'operator-password' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('heading', { name: 'Transfers' })).toBeInTheDocument();
    expect(bodyOf(fetchMock, TRANSFERS)).toEqual({
      password: 'operator-password',
      items: [
        { nodeId: 'catalogue:bee', kind: 'xbzz', amount: '25000000000000000' },
        { nodeId: 'stage-1:bee', kind: 'xdai', amount: '500000000000000000' },
      ],
    });
    expect(screen.getByText('0 of 2 done. This page reads them again every few seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    const link = await screen.findByRole('link', { name: /0xabababab/ });
    expect(link).toHaveAttribute('href', `${EXPLORER_TX_URL}${TX_HASH}`);
    // Failed in a block, which reverted: an end that cannot change, said in the admin's sentence.
    expect(screen.getByText(REVERTED)).toBeInTheDocument();
    expect(screen.getByText('1 of 2 done. This page reads them again every few seconds.')).toBeInTheDocument();

    state = 'confirmed';
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await screen.findByText('Done: 1 confirmed, 1 failed.')).toBeInTheDocument();
    const polls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${TRANSFERS}?`));
    expect(polls.map(([url]) => String(url))).toEqual([
      `${TRANSFERS}?bulkId=6b3f0a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b`,
      `${TRANSFERS}?bulkId=6b3f0a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b`,
    ]);

    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 2));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${TRANSFERS}?`))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === FUNDING).length).toBeGreaterThan(1);
  });

  it('stops reading a transfer still on its way after ten minutes, holding Send, and offers Check again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const item = makeItem({ requestId: 'request-6' });
    const fetchMock = serve(
      () => makeView(),
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () => jsonOk({ bulkId: '0f1e2d3c-4b5a-4968-8776-655443322110', items: [item] }, 202),
        },
        { path: TRANSFERS, respond: () => jsonOk({ items: [{ ...item, txHash: TX_HASH }] }) },
      ],
    );
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Transfers' });

    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_LIMIT_MS + TRANSFER_POLL_MS));
    expect(await screen.findByText('0 of 1 done. The page stopped reading them after 10 minutes.')).toBeInTheDocument();
    const stoppedAt = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 5));
    expect(pollsOf(fetchMock)).toBe(stoppedAt);

    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(WAIT)).toBeInTheDocument();
    // An open send is not put away: dismissing it would not free Send, so only Check again is offered.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(pollsOf(fetchMock)).toBe(stoppedAt + 1));
    expect(screen.getByText('0 of 1 done. This page reads them again every few seconds.')).toBeInTheDocument();
  });

  it('frees Send for a transfer the chain no longer holds, says why, and reads it for ten minutes, then offers Check again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const item = makeItem({ requestId: 'request-3' });
    const fetchMock = serve(
      () => makeView(),
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () => jsonOk({ bulkId: '7c4e1b3f-2d5e-4f60-9bac-1d2e3f4a5b6c', items: [item] }, 202),
        },
        {
          path: TRANSFERS,
          // Unknown for longer than the manager's 30 minutes: settled for Send, and still watched.
          respond: () =>
            jsonOk({
              items: [{ ...item, state: 'unknown', txHash: TX_HASH, error: DROPPED, settled: true, watched: true }],
            }),
        },
      ],
    );
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Transfers' });

    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    const row = within(screen.getByRole('table', { name: 'Transfers sent' }));
    expect(await row.findByText('Not known yet')).toBeInTheDocument();
    expect(row.getByText(DROPPED)).toBeInTheDocument();
    expect(row.getByText(DROPPED_NOTE)).toBeInTheDocument();
    // It says only what is known: the manager has not seen it for its 30 minutes, not that the chain dropped it.
    expect(DROPPED_NOTE).toBe(
      'The manager has not seen it on the chain for 30 minutes, so a new send reuses its nonce. At most one of the two can arrive.',
    );
    const reading =
      'Done: 0 confirmed, 1 not known. This page still reads the one that may yet arrive, every few seconds.';
    expect(screen.getByText(reading)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();

    // Settled for Send: a new send may go, and reuses the nonce, so at most one of the two arrives.
    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument();

    // Still watched, for ten minutes.
    const watched = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(pollsOf(fetchMock)).toBe(watched + 1);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_LIMIT_MS));
    expect(
      await screen.findByText('Done: 0 confirmed, 1 not known. The page stopped reading them after 10 minutes.'),
    ).toBeInTheDocument();
    const stoppedAt = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 5));
    expect(pollsOf(fetchMock)).toBe(stoppedAt);

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(pollsOf(fetchMock)).toBe(stoppedAt + 1));
    expect(screen.getByText(reading)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(pollsOf(fetchMock)).toBe(stoppedAt + 2);
  });

  it("says why the chain's node refused a transfer that reached no block, frees Send, and reads it until it arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent = makeItem({ requestId: 'request-5' });
    let item: FundingTransferItem = {
      ...sent,
      state: 'failed',
      txHash: TX_HASH,
      error: REFUSED_AT_RELAY,
      settled: true,
      watched: true,
    };
    const fetchMock = serve(
      () => makeView(),
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () => jsonOk({ bulkId: '1a2b3c4d-5e6f-4a70-8b91-a2b3c4d5e6f7', items: [sent] }, 202),
        },
        { path: TRANSFERS, respond: () => jsonOk({ items: [item] }) },
      ],
    );
    const views = () => fetchMock.mock.calls.filter(([url]) => String(url) === FUNDING).length;
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Transfers' });

    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    const row = within(screen.getByRole('table', { name: 'Transfers sent' }));
    // The admin's sentence says it all: the node refused it, the row says so if it is mined, check before sending.
    expect(await row.findByText(REFUSED_AT_RELAY)).toBeInTheDocument();
    expect(row.getByText('Failed')).toBeInTheDocument();
    expect(row.queryByText(DROPPED_NOTE)).not.toBeInTheDocument();
    expect(screen.queryByText(/send it again/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Done: 0 confirmed, 1 failed. This page still reads the one that may yet arrive, every few seconds.',
      ),
    ).toBeInTheDocument();

    // Settled for Send.
    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument();

    // Still watched: the manager finds its receipt after all, and the balances are read again.
    const viewsBefore = views();
    item = { ...item, state: 'confirmed', blockNumber: 9, error: null, watched: false };
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await row.findByText('Confirmed')).toBeInTheDocument();
    expect(row.queryByText(REFUSED_AT_RELAY)).not.toBeInTheDocument();
    expect(screen.getByText('Done: the transfer is confirmed.')).toBeInTheDocument();
    await waitFor(() => expect(views()).toBeGreaterThan(viewsBefore));

    const ended = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 3));
    expect(pollsOf(fetchMock)).toBe(ended);
  });
});

describe('a send still open', () => {
  const BULK = '5a2b3c4d-6e7f-4a81-9b2c-3d4e5f6a7b8c';

  it('comes back after a reload, read at once, and keeps Send disabled until it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let open: string | null = null;
    let item = makeItem({ txHash: TX_HASH });
    const fetchMock = serve(
      () => makeView({ openBulkId: open }),
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () => {
            open = BULK;
            return jsonOk({ bulkId: BULK, items: [makeItem()] }, 202);
          },
        },
        { path: TRANSFERS, respond: () => jsonOk({ items: [item] }) },
      ],
    );
    const page = renderWithProviders(<FundingPage />);
    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Transfers' });
    page.unmount();

    // The reload: a fresh page, which knows the send only from the view's openBulkId.
    const before = pollsOf(fetchMock);
    renderWithProviders(<FundingPage />);
    const row = within(await screen.findByRole('table', { name: 'Transfers sent' }));
    expect(await row.findByText('Sent')).toBeInTheDocument();
    expect(pollsOf(fetchMock)).toBe(before + 1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${TRANSFERS}?bulkId=${BULK}`);
    expect(row.getByText('stage-1-uploader')).toBeInTheDocument();
    expect(screen.getByText('0 of 1 done. This page reads them again every few seconds.')).toBeInTheDocument();
    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(WAIT)).toBeInTheDocument();

    item = { ...item, state: 'confirmed', blockNumber: 7, settled: true };
    open = null;
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await screen.findByText('Done: the transfer is confirmed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument();
  });

  it('is followed once a refresh says it is open, as after a send from another tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let open: string | null = null;
    const fetchMock = serve(
      () => makeView({ openBulkId: open }),
      [{ path: TRANSFERS, respond: () => jsonOk({ items: [makeItem({ txHash: TX_HASH })] }) }],
    );
    renderWithProviders(<FundingPage />);
    await screen.findByRole('heading', { name: 'Brand wallet' });
    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Transfers' })).not.toBeInTheDocument();

    open = BULK;
    fireEvent.click(screen.getByRole('button', { name: 'refresh funding' }));
    const row = within(await screen.findByRole('table', { name: 'Transfers sent' }));
    expect(await row.findByText('Sent')).toBeInTheDocument();
    expect(pollsOf(fetchMock)).toBe(1);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(WAIT)).toBeInTheDocument();
  });
});

describe("the server's settled and watched flags", () => {
  const BULK = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

  it('holds Send while an item is not settled, a young unknown one included, and frees it once all are', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The manager lost the answer of its broadcast: unknown, within its 30 minutes, so not settled, and watched.
    const lost = makeItem({ requestId: 'request-7', state: 'unknown', txHash: TX_HASH, settled: false, watched: true });
    let item: FundingTransferItem = lost;
    const fetchMock = serve(
      () => makeView(),
      [
        { path: TRANSFERS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items: [lost] }, 202) },
        { path: TRANSFERS, respond: () => jsonOk({ items: [item] }) },
      ],
    );
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    const row = within(await screen.findByRole('table', { name: 'Transfers sent' }));
    expect(row.getByText('Not known yet')).toBeInTheDocument();
    expect(row.getByText(NOT_KNOWN_YET_NOTE)).toBeInTheDocument();
    expect(row.queryByText(DROPPED_NOTE)).not.toBeInTheDocument();
    expect(screen.getByText('0 of 1 done. This page reads them again every few seconds.')).toBeInTheDocument();
    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(WAIT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    // The manager finds it in the pool: sent, still not settled.
    item = { ...lost, state: 'submitted', settled: false, watched: false };
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await row.findByText('Sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    item = { ...item, state: 'confirmed', blockNumber: 11, settled: true };
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await screen.findByText('Done: the transfer is confirmed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument();

    const ended = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 3));
    expect(pollsOf(fetchMock)).toBe(ended);
  });

  it('keeps reading while any item is watched, and stops once none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const confirmed = makeItem({ state: 'confirmed', txHash: TX_HASH, blockNumber: 7, settled: true });
    const refused = makeItem({
      requestId: 'request-8',
      nodeId: 'catalogue:bee',
      state: 'failed',
      txHash: OTHER_TX_HASH,
      error: REFUSED_AT_RELAY,
      settled: true,
      watched: true,
    });
    let items: FundingTransferItem[] = [confirmed, refused];
    const fetchMock = serve(
      () => makeView(),
      [
        { path: TRANSFERS, method: 'POST', respond: () => jsonOk({ bulkId: BULK, items }, 202) },
        { path: TRANSFERS, respond: () => jsonOk({ items }) },
      ],
    );
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Transfers' });
    enterAnotherSend();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    const before = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 2));
    expect(pollsOf(fetchMock)).toBe(before + 2);

    // The server stops watching it: a failure in a block, final.
    items = [confirmed, { ...refused, blockNumber: 8, error: REVERTED, watched: false }];
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await screen.findByText('Done: 1 confirmed, 1 failed.')).toBeInTheDocument();
    const ended = pollsOf(fetchMock);
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS * 3));
    expect(pollsOf(fetchMock)).toBe(ended);
  });
});

describe('what the password routes and the reading answer', () => {
  it('keeps the dialog for a wrong password, emptying the field, and signs out a session that ended', async () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    let answer = { error: 'invalid_credentials' };
    serve(() => makeView(), [{ path: PINS, method: 'POST', respond: () => jsonError(401, answer) }]);
    renderWithProviders(<FundingPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm addresses' }));
    const dialog = within(await screen.findByRole('dialog'));
    const password = () => dialog.getByLabelText('Your password');
    fireEvent.change(password(), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Confirm addresses' }));
    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument();
    expect(password()).toHaveValue('');
    expect(signedOut).not.toHaveBeenCalled();

    answer = { error: 'unauthenticated' };
    fireEvent.change(password(), { target: { value: 'operator-password' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Confirm addresses' }));
    await waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1));
    expect(await dialog.findByText('Your session ended. Log in again.')).toBeInTheDocument();
  });

  it('says a send was refused because an earlier one is still settling', async () => {
    serve(
      () => makeView(),
      [{ path: TRANSFERS, method: 'POST', respond: () => jsonError(409, { error: 'conflict', message: 'busy' }) }],
    );
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    expect(await dialog.findByText(EARLIER_SEND_SETTLING)).toBeInTheDocument();
  });

  it('says why the transfers could not be read, and reads them again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const item = { requestId: 'request-4', nodeId: 'stage-1:bee', kind: 'xdai', amount: '1000000000000000' };
    const fetchMock = serve(
      () => makeView(),
      [
        {
          path: TRANSFERS,
          method: 'POST',
          respond: () =>
            jsonOk(
              {
                bulkId: '8d5f2c4a-3e6f-4a71-8cbd-2e3f4a5b6c7d',
                items: [{ ...item, state: 'submitted', settled: false, watched: false }],
              },
              202,
            ),
        },
        { path: TRANSFERS, respond: () => jsonError(502, {}) },
      ],
    );
    renderWithProviders(<FundingPage />);

    const dialog = await openSend();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Transfers' });
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(await screen.findByText('request failed (502) Trying again in a few seconds.')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(TRANSFER_POLL_MS));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${TRANSFERS}?`))).toHaveLength(2);
  });
});
