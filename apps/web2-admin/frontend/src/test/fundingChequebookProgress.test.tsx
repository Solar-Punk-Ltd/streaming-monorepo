import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FundingChequebookItem } from '@streaming-monorepo/web2-admin-common';

import { BULK_POLL_MS } from '../components/funding/BulkProgress';
import {
  CHEQUEBOOK_FINAL_NOTE,
  CHEQUEBOOK_READ_AGAIN_NOTE,
  ChequebookProgress,
} from '../components/funding/ChequebookProgress';
import { makeChequebookItem } from './fundingFixtures';
import { jsonOk, mockFetch, renderWithProviders } from './helpers';

const CHEQUEBOOKS = '/api/funding/chequebook-operations';
const BULK = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_TX_HASH = `0x${'cd'.repeat(32)}`;

/** A deposit into the uploader's chequebook, sent, its transaction known. */
const deposit = (over: Partial<FundingChequebookItem> = {}) => makeChequebookItem({ txHash: TX_HASH, ...over });

/** A withdrawal from a rung's chequebook, sent, its transaction known. */
const withdrawal = (over: Partial<FundingChequebookItem> = {}) =>
  makeChequebookItem({
    requestId: 'chequebook-request-2',
    nodeId: 'stage-1:720p',
    nodeLabel: 'rung-720p',
    direction: 'withdraw',
    txHash: OTHER_TX_HASH,
    ...over,
  });

/** The progress of one chequebook bulk, `initial` as the request answered it, each read answering `items()`. */
function follow(initial: FundingChequebookItem[], items: () => FundingChequebookItem[]) {
  mockFetch([{ path: CHEQUEBOOKS, respond: () => jsonOk({ items: items() }) }]);
  renderWithProviders(
    <ChequebookProgress bulkId={BULK} initial={initial} onSettled={() => undefined} onDismiss={() => undefined} />,
  );
  return within(screen.getByRole('table', { name: 'Chequebook operations sent' }));
}

/** The row whose node is `label`. */
const rowOf = (progress: ReturnType<typeof follow>, label: string) =>
  within(progress.getByText(label).closest('tr') as HTMLElement);

/** The chip that says `label` in a row, whose classes say whether it is filled or outlined, and its colour. */
const chipIn = (row: ReturnType<typeof rowOf>, label: string) => row.getByText(label).closest('.MuiChip-root');

/** Lets the page read the bulk again. */
const readAgain = () => act(() => vi.advanceTimersByTimeAsync(BULK_POLL_MS));

afterEach(() => {
  vi.useRealTimers();
});

describe('the Mined step of a chequebook operation', () => {
  it('shows a move Sent, then Mined while its block is not final, then Confirmed, and counts the mined ones', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let items = [deposit(), withdrawal()];
    const progress = follow(items, () => items);

    expect(chipIn(rowOf(progress, 'stage-1-uploader'), 'Sent')).toHaveClass('MuiChip-outlined', 'MuiChip-colorInfo');
    expect(rowOf(progress, 'rung-720p').getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 done. This page reads them again every few seconds.')).toBeInTheDocument();
    expect(screen.getByText(CHEQUEBOOK_FINAL_NOTE)).toBeInTheDocument();
    expect(CHEQUEBOOK_FINAL_NOTE).toBe(
      'A chequebook move is confirmed once its block is final, about 3 minutes after it is mined.',
    );
    expect(screen.getByText(CHEQUEBOOK_READ_AGAIN_NOTE)).toBeInTheDocument();

    // The deposit is mined; its block is not final yet. Its chip has Sent's colour, filled: a step beyond the
    // outlined Sent.
    items = [deposit({ mined: true }), withdrawal()];
    await readAgain();
    expect(await rowOf(progress, 'stage-1-uploader').findByText('Mined')).toBeInTheDocument();
    expect(chipIn(rowOf(progress, 'stage-1-uploader'), 'Mined')).toHaveClass('MuiChip-filled', 'MuiChip-colorInfo');
    expect(chipIn(rowOf(progress, 'stage-1-uploader'), 'Mined')).not.toHaveClass('MuiChip-outlined');
    expect(chipIn(rowOf(progress, 'rung-720p'), 'Sent')).toHaveClass('MuiChip-outlined', 'MuiChip-colorInfo');
    expect(screen.getByText('0 of 2 done, 1 mined. This page reads them again every few seconds.')).toBeInTheDocument();

    items = [deposit({ mined: true }), withdrawal({ mined: true })];
    await readAgain();
    expect(
      await screen.findByText('0 of 2 done, 2 mined. This page reads them again every few seconds.'),
    ).toBeInTheDocument();
    expect(progress.getAllByText('Mined')).toHaveLength(2);
    expect(progress.queryByText('Sent')).not.toBeInTheDocument();

    // The deposit's block is final.
    items = [deposit({ state: 'confirmed', settled: true }), withdrawal({ mined: true })];
    await readAgain();
    expect(await rowOf(progress, 'stage-1-uploader').findByText('Confirmed')).toBeInTheDocument();
    expect(chipIn(rowOf(progress, 'stage-1-uploader'), 'Confirmed')).toHaveClass(
      'MuiChip-outlined',
      'MuiChip-colorSuccess',
    );
    expect(rowOf(progress, 'rung-720p').getByText('Mined')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 done, 1 mined. This page reads them again every few seconds.')).toBeInTheDocument();

    items = [deposit({ state: 'confirmed', settled: true }), withdrawal({ state: 'confirmed', settled: true })];
    await readAgain();
    expect(await screen.findByText('Done: all 2 chequebook operations are confirmed.')).toBeInTheDocument();
    expect(progress.queryByText('Mined')).not.toBeInTheDocument();
    expect(screen.getByText(CHEQUEBOOK_FINAL_NOTE)).toBeInTheDocument();
  });

  it('counts a move still mined past the manager’s 30 minutes in the tally, and reads it on', () => {
    const progress = follow(
      [deposit({ state: 'confirmed', settled: true }), withdrawal({ mined: true, settled: true, watched: true })],
      () => [],
    );

    expect(rowOf(progress, 'rung-720p').getByText('Mined')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Done: 1 confirmed, 1 mined. This page still reads the one that may yet go through, every few seconds.',
      ),
    ).toBeInTheDocument();
  });

  it('says Mined of a sent move alone: one with an outcome shows it, whatever it says of its block', () => {
    const progress = follow(
      [deposit({ state: 'confirmed', settled: true, mined: true }), withdrawal({ state: 'queued', mined: true })],
      () => [],
    );

    expect(rowOf(progress, 'stage-1-uploader').getByText('Confirmed')).toBeInTheDocument();
    expect(rowOf(progress, 'rung-720p').getByText('Queued')).toBeInTheDocument();
    expect(progress.queryByText('Mined')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 done. This page reads them again every few seconds.')).toBeInTheDocument();
  });
});
