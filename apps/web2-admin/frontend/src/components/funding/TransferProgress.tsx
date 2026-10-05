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
 * Said under a transfer the manager answers `unknown` and the server counts as settled: one the manager has not seen
 * on the chain for its 30 minutes. It says no more than that, since the chain may still hold it. A failed transfer has
 * no such line: the admin's own sentence says why it failed, and of one the chain's node refused, that it may still
 * arrive and to check the node's balance before sending again.
 */
export const DROPPED_NOTE =
  'The manager has not seen it on the chain for 30 minutes, so a new send reuses its nonce. At most one of the two can arrive.';

/**
 * Said under a transfer the manager answers `unknown` that is not settled yet: the answer of its broadcast was lost,
 * and it may sit in the chain's pool, so Send waits until the manager can tell, or its 30 minutes pass.
 */
export const NOT_KNOWN_YET_NOTE =
  'The manager cannot tell yet whether the chain took it, so Send waits until it can, 30 minutes at most.';

type ChipColor = 'default' | 'info' | 'success' | 'error' | 'warning';

const STATES: Readonly<Record<string, { label: string; color: ChipColor }>> = {
  queued: { label: 'Queued', color: 'default' },
  submitted: { label: 'Sent', color: 'info' },
  confirmed: { label: 'Confirmed', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  unknown: { label: 'Not known yet', color: 'warning' },
};

/**
 * Whether a transfer has come to an end that cannot change, so the page stops reading it: settled, and no longer
 * watched. Both are the server's flags: `settled` false holds Send back, and `watched` says it may still change.
 */
function ended(item: FundingTransferItem): boolean {
  return item.settled && !item.watched;
}

/** The line above the transfers: how far they are, and whether the page still reads them. */
function summaryOf(items: readonly FundingTransferItem[], stopped: boolean): string {
  const halted = 'The page stopped reading them after 10 minutes.';
  if (items.length === 0) return stopped ? halted : 'Reading the transfers still on their way.';
  const onTheWay = items.filter((item) => !item.settled).length;
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
  const open = items.filter((item) => !ended(item)).length;
  if (open === 0) return `Done: ${tally}.`;
  const watching = stopped
    ? halted
    : `This page still reads the ${open === 1 ? 'one' : open} that may yet arrive, every few seconds.`;
  return `Done: ${tally}. ${watching}`;
}

/**
 * The transfers of one send, item by item, each with its transaction on the block explorer once it has one, read again
 * every three seconds while any of them can still change. Send is free again once the server says every one is
 * `settled`; one it still `watched` (refused at the relay, or not known) is read on, since it may still arrive. After
 * ten minutes the page stops reading and offers Check again. A send the page resumed comes with no items and is read
 * at once.
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
  const settled = !unread && items.every((item) => item.settled);
  const final = !unread && items.every((item) => ended(item));

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
  const endedCount = items.filter((item) => ended(item)).length;
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!settled || told.current === endedCount) return;
    told.current = endedCount;
    onSettled();
  }, [settled, endedCount, onSettled]);

  const done = items.filter((item) => item.settled).length;

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
                          {item.settled ? DROPPED_NOTE : NOT_KNOWN_YET_NOTE}
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
