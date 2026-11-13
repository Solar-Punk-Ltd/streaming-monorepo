import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_BUY_MIN_DAYS,
  ARCHIVE_PURCHASES_NOT_OFFERED,
  archiveBuyQuote,
  XBZZ_DECIMALS,
  type ArchiveBuyTerms,
} from '@streaming-monorepo/web2-admin-common';

import type { BuyStampDialogProps } from '../components/archive/archiveSeams';
import { chunkCount, formatCapacity, purchaseRefusal } from '../components/archive/archiveText';
import { BuyStampDialog, daysProblem, NO_PRICE_TEXT, PAYS_NOTE } from '../components/archive/BuyStampDialog';
import { formatUnits } from '../components/funding/amounts';
import { ApiError } from '../http';
import { POSTAGE } from './fundingFixtures';

/** A catalogue node's wallet with 50 xBZZ and 0.2 xDAI, at the fixtures' price, 30 days by default and 2 the least. */
function makeTerms(over: Partial<ArchiveBuyTerms> = {}): ArchiveBuyTerms {
  return {
    postage: POSTAGE,
    walletXbzzPlur: '500000000000000000',
    walletXdaiWei: '200000000000000000',
    defaultDays: 30,
    minimumDays: ARCHIVE_BUY_MIN_DAYS,
    ...over,
  };
}

function renderDialog(over: Partial<BuyStampDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const props: BuyStampDialogProps = {
    open: true,
    terms: makeTerms(),
    busy: false,
    refusal: null,
    onConfirm,
    onClose,
    ...over,
  };
  const view = render(<BuyStampDialog {...props} />);
  return { ...view, onConfirm, onClose, props };
}

function depthRows(): HTMLElement[] {
  return within(screen.getByRole('table', { name: 'Depths' }))
    .getAllByRole('row')
    .slice(1);
}

function radio(depth: number): HTMLInputElement {
  return screen.getByRole('radio', { name: `Depth ${depth}` }) as HTMLInputElement;
}

function exact(plur: string): string {
  return `${formatUnits(plur, XBZZ_DECIMALS)} xBZZ`;
}

afterEach(() => {
  cleanup();
});

describe('the archive buy dialog', () => {
  it('shows nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers every depth on the Stamps tab, starting on the shallowest, each with what it holds and costs', () => {
    renderDialog();
    const quote = archiveBuyQuote({ days: 30, postage: POSTAGE });
    const rows = depthRows();
    expect(rows).toHaveLength(25);
    expect(within(rows[0]!).getByText('17')).toBeTruthy();
    expect(within(rows[24]!).getByText('41')).toBeTruthy();
    expect(radio(17).checked).toBe(true);
    expect(within(rows[0]!).getByText('44.7 kB')).toBeTruthy();
    expect(within(rows[4]!).getByText('2.6 GB')).toBeTruthy();
    expect(within(rows[24]!).getByText('8.93 PB')).toBeTruthy();
    // Depth 20 for 30 days at 24000 PLUR a block: 518400 blocks, so 12441600000 PLUR a chunk, 2^20 times.
    expect(quote.rows[3]!.costPlur).toBe('13045963161600000');
    expect(within(rows[3]!).getByTitle(exact('13045963161600000')).textContent).toBe('1.305 xBZZ');
    expect(screen.queryByText(/This recording needs/)).toBeNull();
  });

  it('with a recording, starts on the smallest depth that holds it with the margin and offers only deeper ones', () => {
    // 200000 chunks with 5% are 210000: depth 20 holds 167876, depth 21 634765.
    renderDialog({ chunkCount: 200_000 });
    expect(screen.getByText(/This recording needs 210,000 chunks with the 5% margin/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Depth 20' })).toBeNull();
    expect(radio(21).checked).toBe(true);
    expect(depthRows()).toHaveLength(21);
  });

  it('confirms the days typed with the cost shown for them', () => {
    const { onConfirm } = renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: 'Days' }), { target: { value: '45' } });
    const row = archiveBuyQuote({ days: 45, postage: POSTAGE }).rows[0]!;
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    expect(onConfirm).toHaveBeenCalledWith({ depth: 17, days: 45, label: null, costPlur: row.costPlur });
  });

  it('shows the new cost the API answers when the price moved', () => {
    const moved =
      'The price of postage moved, and this stamp now costs 1700000000000000 PLUR. Confirm it again at that cost.';
    const { rerender, props } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    rerender(<BuyStampDialog {...props} refusal={moved} />);
    expect(screen.getByText(moved)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Buy for/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets the user pick a deeper stamp, and confirms it with its exact cost', () => {
    const { onConfirm } = renderDialog({ chunkCount: 200_000 });
    fireEvent.click(radio(23));
    fireEvent.change(screen.getByRole('textbox', { name: 'Label (optional)' }), {
      target: { value: '  Talks 2026  ' },
    });
    const quote = archiveBuyQuote({ chunks: 200_000, days: 30, postage: POSTAGE });
    const row = quote.rows.find((r) => r.depth === 23)!;
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));

    expect(screen.getByRole('heading', { name: 'Buy this archive stamp?' })).toBeTruthy();
    expect(screen.getByText(/A stamp of depth 23, holding 19.9 GB/)).toBeTruthy();
    expect(screen.getByText(/labelled “Talks 2026”/)).toBeTruthy();
    expect(screen.getByText(exact(row.costPlur))).toBeTruthy();
    expect(screen.getByText(PAYS_NOTE)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Buy for/ }));
    expect(onConfirm).toHaveBeenCalledWith({ depth: 23, days: 30, label: 'Talks 2026', costPlur: row.costPlur });
  });

  it('goes back from the confirm step to the choice as it was', () => {
    renderDialog();
    fireEvent.click(radio(22));
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(radio(22).checked).toBe(true);
  });

  it('starts on the default days, prices the rows for the days typed, and refuses fewer than the least', () => {
    renderDialog();
    const days = screen.getByRole('textbox', { name: 'Days' }) as HTMLInputElement;
    expect(days.value).toBe('30');
    const sixty = archiveBuyQuote({ days: 60, postage: POSTAGE }).rows[0]!.costPlur;
    fireEvent.change(days, { target: { value: '60' } });
    expect(within(depthRows()[0]!).getByTitle(exact(sixty))).toBeTruthy();

    fireEvent.change(days, { target: { value: '1' } });
    expect(screen.getByText(daysProblem(2))).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(days, { target: { value: '2' } });
    expect(screen.queryByText(daysProblem(2))).toBeNull();
    expect((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('takes digits only in the days', () => {
    renderDialog();
    const days = screen.getByRole('textbox', { name: 'Days' }) as HTMLInputElement;
    fireEvent.change(days, { target: { value: '3a' } });
    expect(days.value).toBe('30');
  });

  it("names what the catalogue node's wallet holds, and refuses a stamp it cannot pay for", () => {
    renderDialog({ terms: makeTerms({ walletXbzzPlur: '1000000000000000' }) });
    expect(screen.getByText("The catalogue node's wallet holds 0.100 xBZZ and 0.200 xDAI.")).toBeTruthy();
    // Depth 17 for 30 days costs 1630745395200000 PLUR, 630745395200000 more than the wallet holds.
    expect(screen.getByText(/630745395200000 PLUR short of the stamp's cost/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses when the wallet holds no xDAI for the gas', () => {
    renderDialog({ terms: makeTerms({ walletXdaiWei: '0' }) });
    expect(screen.getByText(/holds no xDAI for the gas/)).toBeTruthy();
  });

  it('says so when the wallet was not read, and leaves the check to the manager', () => {
    renderDialog({ terms: makeTerms({ walletXbzzPlur: null, walletXdaiWei: null }) });
    expect(screen.getByText(/wallet could not be read/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('prices nothing without the price of postage', () => {
    renderDialog({ terms: makeTerms({ postage: null }) });
    expect(screen.getByText(NO_PRICE_TEXT)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Depths' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the caller's refusal, and takes no second confirm while busy", () => {
    const { rerender, props, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    rerender(<BuyStampDialog {...props} busy />);
    const buy = screen.getByRole('button', { name: /^Buy for/ }) as HTMLButtonElement;
    expect(buy.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<BuyStampDialog {...props} refusal={ARCHIVE_PURCHASES_NOT_OFFERED} />);
    expect(screen.getByText(ARCHIVE_PURCHASES_NOT_OFFERED)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('starts afresh each time it opens', () => {
    const { rerender, props } = renderDialog();
    fireEvent.click(radio(25));
    rerender(<BuyStampDialog {...props} open={false} />);
    rerender(<BuyStampDialog {...props} open />);
    expect(radio(17).checked).toBe(true);
  });

  it('closes on Cancel', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the archive texts', () => {
  it("shows the API's own sentence for a refused purchase", () => {
    expect(purchaseRefusal(new ApiError(ARCHIVE_PURCHASES_NOT_OFFERED, 'archive_refused', 409))).toBe(
      ARCHIVE_PURCHASES_NOT_OFFERED,
    );
    expect(purchaseRefusal(new ApiError('The wallet is short.', 'archive_refused', 409))).toBe('The wallet is short.');
    expect(purchaseRefusal('nothing')).toBe('The purchase could not be started.');
  });

  it('gives a capacity in three digits at most, and counts chunks', () => {
    expect(formatCapacity(44_700)).toBe('44.7 kB');
    expect(formatCapacity(687_620_000)).toBe('688 MB');
    expect(formatCapacity(1_110_000_000_000_000)).toBe('1.11 PB');
    expect(formatCapacity(512)).toBe('512 B');
    expect(chunkCount(1)).toBe('1 chunk');
    expect(chunkCount(1627)).toBe('1,627 chunks');
  });
});
