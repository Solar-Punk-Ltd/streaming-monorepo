import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material';
import type {
  AutoTopUpMarkItem,
  AutoTopUpStampState,
  AutoTopUpView,
  FundingPostage,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { shortHex } from '../../format';
import { dueMarkNotices, hasSwitch, markKey, markLines, marksOf, type MarkLines } from './autoTopUp';
import { allBatchRows, batchCount, hasTickBox, type BatchRow } from './stamps';

/** The Auto top-up view as a tab reads it: the view once read, why it could not be, and a way to read it again. */
export interface AutoTopUpRead {
  view: AutoTopUpView | null;
  error: string | null;
  load: () => void;
  /** Takes a write's answer, the whole view, as the view. */
  setView: (view: AutoTopUpView) => void;
}

/**
 * Reads `GET /api/funding/auto-top-up` when the tab mounts, and again on `load`. Only the latest read is answered, as
 * the Funding view's reads are, and a write's answer replaces the view.
 */
export function useAutoTopUp(): AutoTopUpRead {
  const [view, setView] = useState<AutoTopUpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);

  const load = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    setError(null);
    api
      .fetchAutoTopUp()
      .then((next) => {
        if (read === reads.current) setView(next);
      })
      .catch((e: unknown) => {
        if (read === reads.current) setError(errorMessage(e, 'The auto top-up view could not be read.'));
      });
  }, []);

  useEffect(load, [load]);

  const take = useCallback((next: AutoTopUpView) => {
    reads.current += 1;
    setError(null);
    setView(next);
  }, []);

  return { view, error, load, setView: take };
}

/** Why the switches are missing: the view could not be read. */
export function autoTopUpUnread(error: string): string {
  return `Auto top-up could not be read: ${error}`;
}

/** What the Stamps tab gives its tables for the switches. */
export interface AutoControls {
  markOf: (batchId: string) => AutoTopUpStampState | undefined;
  /** Whether the row has a switch: it can be topped up now, or it is marked. */
  hasSwitch: (row: BatchRow, mark: AutoTopUpStampState | undefined) => boolean;
  linesOf: (row: BatchRow, mark: AutoTopUpStampState) => MarkLines;
  /** True while a mark is on its way, when every switch waits. */
  busy: boolean;
  onSwitch: (row: BatchRow, mark: AutoTopUpStampState | undefined, on: boolean) => void;
}

/** The switch's name, which says which batch it marks, as the row's tick box names it. */
function switchLabel(row: BatchRow): string {
  return row.archive
    ? `Auto top-up for the archive stamp ${row.archive.label ?? shortHex(row.batch.batchId)}`
    : `Auto top-up for the batch of ${row.node.label}`;
}

/**
 * The Auto top-up switch under a row's batch, and under it on a marked row: its last automatic top-up, about when its
 * next falls due and what it costs, and in red what stopped its last attempt.
 */
export function AutoTopUpLine({ row, auto }: { row: BatchRow; auto: AutoControls }) {
  const mark = auto.markOf(row.batch.batchId);
  if (!auto.hasSwitch(row, mark)) return null;
  const lines = mark ? auto.linesOf(row, mark) : null;
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={mark !== undefined}
            disabled={auto.busy}
            onChange={(event) => auto.onSwitch(row, mark, event.target.checked)}
            slotProps={{ input: { 'aria-label': switchLabel(row) } }}
          />
        }
        label={<Typography variant="body2">Auto top-up</Typography>}
        sx={{ ml: 0, mr: 0 }}
      />
      {lines ? (
        <>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {lines.last}
          </Typography>
          {lines.next ? (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {lines.next}
            </Typography>
          ) : null}
          {lines.problem ? (
            <Typography variant="caption" sx={{ color: 'error.main' }}>
              {lines.problem}
            </Typography>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

/** What the Stamps tab lists, as `allBatchRows` takes it. */
type Inventory = Parameters<typeof allBatchRows>[0];

/** The mark item of a row: the node that holds the batch, or for one marked already, the node it was marked with. */
function itemOf(row: BatchRow, mark: AutoTopUpStampState | undefined): AutoTopUpMarkItem {
  return { nodeId: mark?.nodeId ?? row.node.nodeId, batchId: row.batch.batchId };
}

/**
 * The marks on the Stamps tab: the view they are read from, the switch on each row that can be topped up or is marked,
 * and the ticked batches to mark or unmark together. A mark answers the whole view, which the switches then show; a
 * refusal, such as the 409 `not_markable`, shows its sentence and leaves the view as it was. Marking a stamp that is
 * already due says at once what its top-up costs, whether its node holds that, and when the brand wallet sends the
 * rest (`dueMarkNotices`). `now` is when the Funding view was read, which a row's next top-up counts from.
 */
export function useAutoTopUpMarks(
  inventory: Inventory | null,
  ticked: ReadonlySet<string>,
  postage: FundingPostage | null,
  now: number,
) {
  const read = useAutoTopUp();
  const { view, setView } = read;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  const marks = useMemo(() => marksOf(view), [view]);
  const rows = useMemo(() => (inventory ? allBatchRows(inventory, 'topup') : []), [inventory]);
  const tickedRows = useMemo(
    () => rows.filter((row) => ticked.has(row.batch.batchId) && hasTickBox(row, 'topup')),
    [rows, ticked],
  );
  const on = tickedRows.filter((row) => !marks.has(markKey(row.batch.batchId)));
  const off = tickedRows.filter((row) => marks.has(markKey(row.batch.batchId)));

  const mark = useCallback(
    async (marked: boolean, items: AutoTopUpMarkItem[]) => {
      if (items.length === 0) return;
      setBusy(true);
      setError(null);
      setNotices([]);
      try {
        const next = await api.setAutoTopUpMarks(marked, items);
        setView(next);
        if (marked) {
          setNotices(
            dueMarkNotices(
              items.map((item) => item.batchId),
              rows,
              next,
              postage,
              Date.now(),
            ),
          );
        }
      } catch (e: unknown) {
        setError(errorMessage(e, 'The auto top-up marks could not be saved.'));
      } finally {
        setBusy(false);
      }
    },
    [postage, rows, setView],
  );

  const controls: AutoControls | null = useMemo(() => {
    if (!view) return null;
    return {
      markOf: (batchId) => marks.get(markKey(batchId)),
      hasSwitch: (row, each) => hasSwitch(row, each !== undefined),
      linesOf: (row, each) => markLines(each, row.batch, view.settings, postage, now),
      busy,
      onSwitch: (row, each, switchOn) => void mark(switchOn, [itemOf(row, each)]),
    };
  }, [view, marks, postage, now, busy, mark]);

  return {
    controls,
    unread: view ? null : read.error,
    reload: read.load,
    on,
    off,
    busy,
    markTicked: (marked: boolean) =>
      void mark(
        marked,
        (marked ? on : off).map((row) => itemOf(row, marks.get(markKey(row.batch.batchId)))),
      ),
    error,
    clearError: () => setError(null),
    notices,
    clearNotices: () => setNotices([]),
  };
}

/** What the bar says the switch does. */
export const AUTO_TOP_UP_CAPTION =
  'Auto top-up keeps a marked batch alive: under the threshold, its node tops it up to the level, and the brand wallet sends a short node what it lacks a day after an alert. The Auto top-up tab holds the numbers.';

/**
 * Auto top-up for the ticked batches: on for those not marked yet, off for those that are, as Select all and the
 * group tick boxes tick them.
 */
export function AutoTopUpBar({
  on,
  off,
  busy,
  onMark,
}: {
  on: number;
  off: number;
  busy: boolean;
  onMark: (marked: boolean) => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {AUTO_TOP_UP_CAPTION}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" disabled={busy || on === 0} onClick={() => onMark(true)}>
            Auto top-up on for {batchCount(on)}
          </Button>
          <Button variant="outlined" disabled={busy || off === 0} onClick={() => onMark(false)}>
            Auto top-up off for {batchCount(off)}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
