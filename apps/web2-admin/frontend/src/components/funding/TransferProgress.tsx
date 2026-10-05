import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Chip,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import type { FundingTransferItem } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { shortHex } from '../../format';
import { formatUnits } from './amounts';
import { TOKENS, txUrl } from './balance';

/** How often the transfers of a bulk are read again while any of them can still change. */
export const TRANSFER_POLL_MS = 3_000;

/**
 * How long the page keeps reading a bulk whose transfers can still change, from the send, from the page finding it
 * open, or from the last Check again. A transfer the chain refused or no longer holds may stay so for good, so the page
 * stops and lets the operator ask again.
 */
export const TRANSFER_POLL_LIMIT_MS = 10 * 60_000;

/**
 * Said under a transfer the manager answers `unknown`, one the chain no longer holds. A failed transfer has no such
 * line: the admin's own sentence says why it failed, and of one the chain's node refused, that it may still arrive and
 * to check the node's balance before sending again.
 */
export const DROPPED_NOTE =
  'The chain no longer holds it, so a new send reuses its nonce. At most one of the two can arrive.';

type ChipColor = 'default' | 'info' | 'success' | 'error' | 'warning';

const STATES: Readonly<Record<string, { label: string; color: ChipColor }>> = {
  queued: { label: 'Queued', color: 'default' },
  submitted: { label: 'Sent', color: 'info' },
  confirmed: { label: 'Confirmed', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  unknown: { label: 'Not known yet', color: 'warning' },
};

/**
 * Whether a transfer no longer holds Send back: confirmed, failed, or `unknown`, which the chain no longer holds, so a
 * new send reuses its nonce. A transfer queued or sent holds it.
 */
export function transferSettled(item: FundingTransferItem): boolean {
  return item.state === 'confirmed' || item.state === 'failed' || item.state === 'unknown';
}

/**
 * Whether a transfer has come to an end that cannot change: confirmed, or failed in a block, which reverted. The page
 * stops reading it then. A failed one with no block, which the chain's node refused at the relay, and an `unknown` one
 * may still arrive, so the page reads them on. The send's own answer may leave the block out, which reads as none.
 */
export function transferFinal(item: FundingTransferItem): boolean {
  return item.state === 'confirmed' || (item.state === 'failed' && typeof item.blockNumber === 'number');
}

/** The line above the transfers: how far they are, and whether the page still reads them. */
function summaryOf(items: readonly FundingTransferItem[], stopped: boolean): string {
  const halted = 'The page stopped reading them after 10 minutes.';
  if (items.length === 0) return stopped ? halted : 'Reading the transfers still on their way.';
  const onTheWay = items.filter((item) => !transferSettled(item)).length;
  if (onTheWay > 0) {
    const reading = stopped ? halted : 'This page reads them again every few seconds.';
    return `${items.length - onTheWay} of ${items.length} done. ${reading}`;
  }

  // Settled for Send. Said as a tally, then whether the page still reads the ones that may yet arrive.
  const count = (state: FundingTransferItem['state']) => items.filter((item) => item.state === state).length;
  const confirmed = count('confirmed');
  const failed = count('failed');
  const unknown = count('unknown');
  let tally: string;
  if (confirmed === items.length) {
    tally = items.length === 1 ? 'the transfer is confirmed' : `all ${items.length} transfers are confirmed`;
  } else {
    const parts = [`${confirmed} confirmed`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (unknown > 0) parts.push(`${unknown} not known`);
    tally = parts.join(', ');
  }
  const open = items.filter((item) => !transferFinal(item)).length;
  if (open === 0) return `Done: ${tally}.`;
  const watching = stopped
    ? halted
    : `This page still reads the ${open === 1 ? 'one' : open} that may yet arrive, every few seconds.`;
  return `Done: ${tally}. ${watching}`;
}

/**
 * The transfers of one send, item by item, each with its transaction on the block explorer once it has one, read again
 * every three seconds while any of them can still change. Send is free again once none is queued or sent; a transfer
 * refused at relay or no longer held by the chain is read on, since it may still arrive. After ten minutes the page
 * stops reading and offers Check again. A send the page resumed comes with no items and is read at once.
 */
export function TransferProgress({
  bulkId,
  initial,
  labels,
  onSettled,
  onDismiss,
}: {
  bulkId: string;
  /** What the send answered, or none for a send the page resumed from the view's `openBulkId`. */
  initial: readonly FundingTransferItem[];
  labels: ReadonlyMap<string, string>;
  /** Said when the transfers no longer hold Send back, and again each time one more comes to its end after that. */
  onSettled: () => void;
  onDismiss: () => void;
}) {
  const [items, setItems] = useState<readonly FundingTransferItem[]>(initial);
  const [readingSince, setReadingSince] = useState(() => Date.now());
  const [stopped, setStopped] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  // No items is a send the page resumed and has not read yet, never one that settled: it holds Send until it is read.
  const unread = items.length === 0;
  const settled = !unread && items.every((item) => transferSettled(item));
  const final = !unread && items.every((item) => transferFinal(item));

  // One read of the bulk, for the interval and for Check again. A failed read is said, and forgotten once one succeeds.
  const read = useCallback(() => {
    api
      .fetchFundingTransfers(bulkId)
      .then((next) => {
        setItems(next);
        setReadError(null);
      })
      .catch((e: unknown) => setReadError(errorMessage(e, 'Could not read the transfers.')));
  }, [bulkId]);

  // A resumed send is read at once, not after the first interval.
  const readAtOnce = useRef(initial.length === 0);
  useEffect(() => {
    if (!readAtOnce.current) return;
    readAtOnce.current = false;
    read();
  }, [read]);

  useEffect(() => {
    if (final || stopped) return undefined;
    const timer = setInterval(() => {
      if (Date.now() - readingSince >= TRANSFER_POLL_LIMIT_MS) {
        setStopped(true);
        return;
      }
      read();
    }, TRANSFER_POLL_MS);
    return () => clearInterval(timer);
  }, [read, final, stopped, readingSince]);

  const checkAgain = () => {
    setStopped(false);
    setReadingSince(Date.now());
    read();
  };

  // Said when Send is free again, and again whenever one more transfer ends after that, so the page reads the
  // balances again each time they can have moved.
  const ended = items.filter((item) => transferFinal(item)).length;
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!settled || told.current === ended) return;
    told.current = ended;
    onSettled();
  }, [settled, ended, onSettled]);

  const done = items.filter((item) => transferSettled(item)).length;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1" component="h2" sx={{ flexGrow: 1 }}>
            Transfers
          </Typography>
          {stopped && !final ? (
            <Button size="small" onClick={checkAgain}>
              Check again
            </Button>
          ) : null}
          {/* A send that still holds Send back stays: dismissing it would not free Send. */}
          {settled ? (
            <Button size="small" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </Stack>
        <Typography variant="body2">{summaryOf(items, stopped)}</Typography>
        {readError && !final ? (
          <Typography variant="body2" sx={{ color: 'error.main' }}>
            {stopped ? readError : `${readError} Trying again in a few seconds.`}
          </Typography>
        ) : null}
        <LinearProgress
          aria-label="Transfer progress"
          variant={unread ? 'indeterminate' : 'determinate'}
          value={unread ? undefined : (100 * done) / items.length}
        />
        <Table size="small" aria-label="Transfers sent">
          <TableBody>
            {items.map((item) => {
              const state = STATES[item.state] ?? { label: item.state, color: 'default' as const };
              return (
                <TableRow key={item.requestId}>
                  <TableCell>{labels.get(item.nodeId) ?? item.nodeId}</TableCell>
                  <TableCell align="right">
                    {formatUnits(item.amount, TOKENS[item.kind].decimals)} {TOKENS[item.kind].name}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" color={state.color} label={state.label} />
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      {item.txHash ? (
                        <Link href={txUrl(item.txHash)} target="_blank" rel="noreferrer" variant="body2">
                          {shortHex(item.txHash, 10, 8)}
                        </Link>
                      ) : null}
                      {item.error ? (
                        <Typography variant="caption" sx={{ color: 'error.main' }}>
                          {item.error}
                        </Typography>
                      ) : null}
                      {item.state === 'unknown' ? (
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {DROPPED_NOTE}
                        </Typography>
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Stack>
    </Paper>
  );
}
