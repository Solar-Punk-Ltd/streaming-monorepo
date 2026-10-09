import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import type { FundingItemState } from '@streaming-monorepo/web2-admin-common';

import { errorMessage } from '../../errors';
import { shortHex } from '../../format';
import { txUrl } from './balance';

/** How often the items of a bulk are read again while any of them can still change. */
export const BULK_POLL_MS = 3_000;

/**
 * How long the page keeps reading a bulk whose items can still change, from the request, from the page finding it
 * open, or from the last Check again. An item the chain refused or no longer holds may stay so for good, so the page
 * stops and lets the operator ask again.
 */
export const BULK_POLL_LIMIT_MS = 10 * 60_000;

/**
 * What the page reads of every item of a bulk, a transfer and a stamp operation alike: where it stands, its
 * transaction and its error once it has them, and the server's two flags. `settled` false holds the next bulk of its
 * kind back, and `watched` says it may still change although it has an outcome.
 */
export interface BulkItem {
  requestId: string;
  state: FundingItemState;
  txHash: string | null;
  error: string | null;
  settled: boolean;
  watched: boolean;
  /**
   * Whether its move is mined and waits for its block to be final, which only a chequebook operation says: the
   * manager confirms one only once its block is final. Shown as Mined, between Sent and Confirmed.
   */
  mined?: boolean;
}

/** How a bulk's progress names what it follows. */
export interface BulkWords {
  /** The heading, such as `Transfers`. The table of items is `<title> sent`. */
  title: string;
  /** One item, such as `transfer`. The progress bar is `<one> progress`, capitalised. */
  one: string;
  /** More than one, such as `transfers`. */
  many: string;
  /** What an item that may still change may yet do, such as `arrive`. */
  mayYet: string;
}

/** The bulk a tab follows: one it made, or the one the view says is still open. */
export interface FollowedBulk<Item> {
  bulkId: string;
  /** What the request answered, or none for an open bulk the page found in the view, which it then reads at once. */
  items: readonly Item[];
  /** Whether its items no longer hold the next bulk back. */
  settled: boolean;
}

/**
 * The bulk to follow once the view is read. The view's open bulk is followed when the page follows none, or one that
 * no longer holds the next one back, so a reload or another tab finds it again. A bulk the page follows that still
 * holds the next one back is kept: the view may have been read before it was made.
 */
export function followBulk<Item>(
  current: FollowedBulk<Item> | null,
  openBulkId: string | null,
): FollowedBulk<Item> | null {
  if (!openBulkId || openBulkId === current?.bulkId) return current;
  if (current && !current.settled) return current;
  return { bulkId: openBulkId, items: [], settled: false };
}

type ChipColor = 'default' | 'info' | 'success' | 'error' | 'warning';

const STATES: Readonly<Record<string, { label: string; color: ChipColor }>> = {
  queued: { label: 'Queued', color: 'default' },
  submitted: { label: 'Sent', color: 'info' },
  confirmed: { label: 'Confirmed', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  unknown: { label: 'Not known yet', color: 'warning' },
};

/** How a chip looks: its label, its colour, and whether it is filled or outlined. */
interface ChipLook {
  label: string;
  color: ChipColor;
  variant: 'filled' | 'outlined';
}

/**
 * The chip of a sent item whose move is mined and waits for its block to be final: Sent's colour, since the move is
 * still under way, and filled, so it reads as a step beyond the outlined Sent.
 */
const MINED: ChipLook = { label: 'Mined', color: 'info', variant: 'filled' };

/** Whether an item is mined and waits for its block to be final: a step of a sent one, never of one with an outcome. */
function isMined(item: BulkItem): boolean {
  return item.state === 'submitted' && item.mined === true;
}

/** An item's chip: Mined for one mined and not final yet, otherwise its state's, outlined. */
function chipOf(item: BulkItem): ChipLook {
  if (isMined(item)) return MINED;
  const state = STATES[item.state] ?? { label: item.state, color: 'default' };
  return { ...state, variant: 'outlined' };
}

/**
 * Whether an item has come to an end that cannot change, so the page stops reading it: settled, and no longer
 * watched. Both are the server's flags.
 */
function ended(item: BulkItem): boolean {
  return item.settled && !item.watched;
}

/** The line above the items: how far they are, how many are mined, and whether the page still reads them. */
function summaryOf(items: readonly BulkItem[], stopped: boolean, words: BulkWords): string {
  const halted = 'The page stopped reading them after 10 minutes.';
  if (items.length === 0) return stopped ? halted : `Reading the ${words.many} still on their way.`;
  const mined = items.filter(isMined).length;
  const onTheWay = items.filter((item) => !item.settled).length;
  if (onTheWay > 0) {
    const reading = stopped ? halted : 'This page reads them again every few seconds.';
    return `${items.length - onTheWay} of ${items.length} done${mined > 0 ? `, ${mined} mined` : ''}. ${reading}`;
  }

  // Settled. Said as a tally, then whether the page still reads the ones that may yet change.
  const count = (state: FundingItemState) => items.filter((item) => item.state === state).length;
  const confirmed = count('confirmed');
  const failed = count('failed');
  const unknown = count('unknown');
  let tally: string;
  if (confirmed === items.length) {
    tally = items.length === 1 ? `the ${words.one} is confirmed` : `all ${items.length} ${words.many} are confirmed`;
  } else {
    const parts = [`${confirmed} confirmed`];
    if (mined > 0) parts.push(`${mined} mined`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (unknown > 0) parts.push(`${unknown} not known`);
    tally = parts.join(', ');
  }
  const open = items.filter((item) => !ended(item)).length;
  if (open === 0) return `Done: ${tally}.`;
  const watching = stopped
    ? halted
    : `This page still reads the ${open === 1 ? 'one' : open} that may yet ${words.mayYet}, every few seconds.`;
  return `Done: ${tally}. ${watching}`;
}

/**
 * The items of one bulk, a send's transfers, a stamp bulk's or a chequebook bulk's operations, item by item, each with
 * its transaction on the block explorer once it has one, read again every three seconds while any of them can still
 * change. A sent item whose move is mined and waits for its block to be final, which only a chequebook operation
 * says, shows Mined between Sent and Confirmed, and the summary counts those. The next bulk of its kind is free once
 * the server says every item is `settled`; one it still `watched` is read on, since it may still change. After ten
 * minutes the page stops reading and offers Check again. A bulk the page resumed comes with no items and is read at
 * once.
 */
export function BulkProgress<Item extends BulkItem>({
  bulkId,
  initial,
  words,
  read: readItems,
  describe,
  note,
  timing,
  footnote,
  onSettled,
  onDismiss,
}: {
  bulkId: string;
  /** What the request answered, or none for a bulk the page resumed from the view. */
  initial: readonly Item[];
  words: BulkWords;
  /** Reads the bulk's items as the server has them now. Keeps its identity from render to render. */
  read: (bulkId: string) => Promise<readonly Item[]>;
  /** The cells that say what an item is, before its state. */
  describe: (item: Item) => ReactNode;
  /** A line under an item's state, such as why the server cannot tell yet, or null. */
  note: (item: Item) => string | null;
  /** A line under the summary that says how long an item takes to be confirmed, or none. */
  timing?: string;
  /** A line under the items, or none. */
  footnote?: string;
  /** Said when the items no longer hold the next bulk back, and again each time one more comes to its end after that. */
  onSettled: () => void;
  onDismiss: () => void;
}) {
  const [items, setItems] = useState<readonly Item[]>(initial);
  const [readingSince, setReadingSince] = useState(() => Date.now());
  const [stopped, setStopped] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  // No items is a bulk the page resumed and has not read yet, never one that settled: it holds the next one until read.
  const unread = items.length === 0;
  const settled = !unread && items.every((item) => item.settled);
  const final = !unread && items.every((item) => ended(item));

  // One read of the bulk, for the interval and for Check again. A failed read is said, and forgotten once one succeeds.
  const read = useCallback(() => {
    readItems(bulkId)
      .then((next) => {
        setItems(next);
        setReadError(null);
      })
      .catch((e: unknown) => setReadError(errorMessage(e, `Could not read the ${words.many}.`)));
  }, [readItems, bulkId, words.many]);

  // A resumed bulk is read at once, not after the first interval.
  const readAtOnce = useRef(initial.length === 0);
  useEffect(() => {
    if (!readAtOnce.current) return;
    readAtOnce.current = false;
    read();
  }, [read]);

  useEffect(() => {
    if (final || stopped) return undefined;
    const timer = setInterval(() => {
      if (Date.now() - readingSince >= BULK_POLL_LIMIT_MS) {
        setStopped(true);
        return;
      }
      read();
    }, BULK_POLL_MS);
    return () => clearInterval(timer);
  }, [read, final, stopped, readingSince]);

  const checkAgain = () => {
    setStopped(false);
    setReadingSince(Date.now());
    read();
  };

  // Said when the next bulk is free again, and again whenever one more item ends after that, so the page reads the
  // view again each time it can have moved.
  const endedCount = items.filter((item) => ended(item)).length;
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!settled || told.current === endedCount) return;
    told.current = endedCount;
    onSettled();
  }, [settled, endedCount, onSettled]);

  const done = items.filter((item) => item.settled).length;
  const one = `${words.one.charAt(0).toUpperCase()}${words.one.slice(1)}`;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1" component="h2" sx={{ flexGrow: 1 }}>
            {words.title}
          </Typography>
          {stopped && !final ? (
            <Button size="small" onClick={checkAgain}>
              Check again
            </Button>
          ) : null}
          {/* A bulk that still holds the next one back stays: dismissing it would not free it. */}
          {settled ? (
            <Button size="small" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </Stack>
        <Typography variant="body2">{summaryOf(items, stopped, words)}</Typography>
        {timing ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {timing}
          </Typography>
        ) : null}
        {readError && !final ? (
          <Typography variant="body2" sx={{ color: 'error.main' }}>
            {stopped ? readError : `${readError} Trying again in a few seconds.`}
          </Typography>
        ) : null}
        <LinearProgress
          aria-label={`${one} progress`}
          variant={unread ? 'indeterminate' : 'determinate'}
          value={unread ? undefined : (100 * done) / items.length}
        />
        <Table size="small" aria-label={`${words.title} sent`}>
          <TableBody>
            {items.map((item) => {
              const state = chipOf(item);
              const line = note(item);
              return (
                <TableRow key={item.requestId}>
                  {describe(item)}
                  <TableCell>
                    <Chip size="small" variant={state.variant} color={state.color} label={state.label} />
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
                      {line ? (
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {line}
                        </Typography>
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {footnote ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {footnote}
          </Typography>
        ) : null}
      </Stack>
    </Paper>
  );
}
