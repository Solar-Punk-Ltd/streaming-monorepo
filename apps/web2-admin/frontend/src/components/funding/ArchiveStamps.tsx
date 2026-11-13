import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Paper, Stack, Typography } from '@mui/material';
import {
  XBZZ_DECIMALS,
  type ArchiveBuyChoice,
  type ArchiveStampPurchase,
  type ArchiveStampsResponse,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { BuyStampDialog } from '../archive/BuyStampDialog';
import { purchaseRefusal } from '../archive/archiveText';
import { formatShort } from './amounts';

/** How often the tab reads the archive stamps again while a purchase is still running. */
export const PURCHASE_POLL_MS = 10_000;

/** Said in the group when the archive stamps could not be read, with why. */
export function archiveReadFailed(error: string): string {
  return `The archive stamps could not be read: ${error}`;
}

/** Said when Buy is pressed before the archive stamps were read for the first time. */
export const STILL_READING = 'The archive stamps are still being read. Try again in a moment.';

/** Whether a purchase is still on its way: the node has not bought the batch yet, or it is not usable yet. */
export function purchaseRunning(purchase: ArchiveStampPurchase): boolean {
  return purchase.state === 'buying' || purchase.state === 'waiting_usable';
}

/** Where a purchase stands, in a few words. */
export function purchaseStateText(purchase: ArchiveStampPurchase): string {
  switch (purchase.state) {
    case 'buying':
      return 'Being bought';
    case 'waiting_usable':
      return 'Bought, waiting to be usable';
    case 'usable':
      return 'Bought and usable';
    case 'failed':
      return `Failed (${purchase.error ?? 'the node did not buy it'})`;
  }
}

/** One purchase in a line: the state, the depth, the label and what it costs. */
export function purchaseLine(purchase: ArchiveStampPurchase): string {
  const label = purchase.label ? ` “${purchase.label}”` : '';
  return `${purchaseStateText(purchase)}: depth ${purchase.depth}${label}, ${formatShort(purchase.costPlur, XBZZ_DECIMALS)} xBZZ.`;
}

export interface ArchiveStampsRead {
  stamps: ArchiveStampsResponse | null;
  error: string | null;
  /** Reads the archive stamps again now. */
  reload: () => void;
}

/**
 * The archive stamps as the admin answers them, read when `version` changes, which is each time the tab reads the
 * Funding view, and again every {@link PURCHASE_POLL_MS} while a purchase is running. `onPurchaseSettled` is called
 * once fewer purchases are running than at the read before, so the tab reads the view again and lists the new batch.
 */
export function useArchiveStamps(version: unknown, onPurchaseSettled: () => void): ArchiveStampsRead {
  const [stamps, setStamps] = useState<ArchiveStampsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef<number | null>(null);
  const settled = useRef(onPurchaseSettled);
  useEffect(() => {
    settled.current = onPurchaseSettled;
  }, [onPurchaseSettled]);

  const read = useCallback(async (background: boolean) => {
    try {
      const next = await api.fetchArchiveStamps({ background });
      const now = next.purchases.filter(purchaseRunning).length;
      const before = running.current;
      running.current = now;
      setStamps(next);
      setError(null);
      if (before !== null && now < before) settled.current();
    } catch (e: unknown) {
      setError(errorMessage(e, 'The archive stamps could not be read.'));
    }
  }, []);

  useEffect(() => {
    void read(false);
  }, [read, version, tick]);

  const anyRunning = stamps?.purchases.some(purchaseRunning) ?? false;
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => void read(true), PURCHASE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, read]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { stamps, error, reload };
}

/**
 * Under the archive stamps: why they could not be read, the purchases still running, and "Buy archive stamp", which
 * opens the buy dialog with every depth, since no recording is being sized here. The button stays on whatever the
 * admin answered: when no stamp can be bought now it says why instead of opening the dialog, and a purchase the manager
 * does not offer is said in the dialog. A purchase started here is followed in the list until it is usable.
 */
export function ArchiveStampsFooter({ read, onBought }: { read: ArchiveStampsRead; onBought: () => void }) {
  const { stamps, error, reload } = read;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState<ArchiveStampPurchase | null>(null);

  const openBuy = () => {
    if (stamps?.buy) {
      setRefusal(null);
      setNotice(null);
      setOpen(true);
      return;
    }
    setNotice(stamps?.buyUnavailable ?? (error ? archiveReadFailed(error) : STILL_READING));
  };

  const confirm = async (choice: ArchiveBuyChoice) => {
    setBusy(true);
    setRefusal(null);
    try {
      const purchase = await api.buyArchiveStamp(choice);
      setOpen(false);
      setFailed(purchase.state === 'failed' ? purchase : null);
      reload();
      onBought();
    } catch (e: unknown) {
      setRefusal(purchaseRefusal(e));
    } finally {
      setBusy(false);
    }
  };

  const purchases = stamps?.purchases ?? [];
  return (
    <Stack spacing={1}>
      {error ? <Alert severity="warning">{archiveReadFailed(error)}</Alert> : null}
      {purchases.length > 0 ? (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Stack spacing={0.5} role="list" aria-label="Archive stamp purchases">
            {purchases.map((purchase) => (
              <Typography
                key={purchase.id}
                role="listitem"
                variant="body2"
                sx={{ color: purchase.state === 'failed' ? 'error.main' : 'text.primary' }}
              >
                {purchaseLine(purchase)}
              </Typography>
            ))}
          </Stack>
        </Paper>
      ) : null}
      {failed ? (
        <Alert severity="error" onClose={() => setFailed(null)}>
          {purchaseLine(failed)}
        </Alert>
      ) : null}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Button variant="outlined" onClick={openBuy}>
          Buy archive stamp
        </Button>
      </Stack>
      {notice ? (
        <Alert severity="info" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}
      {stamps?.buy ? (
        <BuyStampDialog
          open={open}
          terms={stamps.buy}
          busy={busy}
          refusal={refusal}
          onConfirm={(choice) => void confirm(choice)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Stack>
  );
}
