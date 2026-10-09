import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Alert, Box, Button, InputAdornment, Paper, Stack, TextField, Typography } from '@mui/material';
import { XBZZ_DECIMALS, type FundingChequebookItem, type FundingView } from '@streaming-monorepo/web2-admin-common';

import { acceptsAmountTyping, formatShort, formatUnits } from './amounts';
import { fundNeeds, type FundNeed } from './balance';
import { followBulk, type FollowedBulk } from './BulkProgress';
import { ChequebookDialog } from './ChequebookDialog';
import { ChequebookProgress } from './ChequebookProgress';
import { ChequebookTable } from './ChequebookTable';
import {
  chequebookGroups,
  checkChequebooks,
  depositCount,
  MINUS,
  movableChequebooks,
  NO_CHEQUEBOOKS_REPORTED,
  readTarget,
  reportsChequebooks,
  TARGET_CAPTION,
  TARGET_FLOOR_TEXT,
  withdrawalCount,
  type ChequebookCheck,
  type ChequebookSelection,
  type ChequebookTotal,
} from './chequebooks';
import { FundingFrame, useFundingView } from './FundingFrame';
import { SelectAllBar, withTicks } from './Ticks';

/** Said while a chequebook bulk is still on its way, so a second one does not start before the first has settled. */
export const WAIT_FOR_CHEQUEBOOKS = 'Wait for the chequebook operations above to finish.';

/** Said when the manager reports no stage, so there is no chequebook to list. */
export const NO_STAGES = 'The manager reports no stages yet.';

/**
 * The target, the chequebook balance wanted, in xBZZ: digits and one dot only, as the amount fields take them, with
 * the floor beside it. A target the page cannot take outlines the field in red, with why as its tooltip, and the bar
 * says it too.
 */
function TargetControls({ target, onTarget }: { target: string; onTarget: (target: string) => void }) {
  const read = readTarget(target);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <TextField
            size="small"
            label="Target"
            value={target}
            onChange={(e) => {
              if (acceptsAmountTyping(e.target.value)) onTarget(e.target.value);
            }}
            error={read.kind === 'invalid'}
            title={read.kind === 'invalid' ? read.problem : undefined}
            slotProps={{
              htmlInput: { inputMode: 'decimal' },
              input: { endAdornment: <InputAdornment position="end">xBZZ</InputAdornment> },
            }}
            sx={{
              width: 240,
              flexShrink: 0,
              '& .MuiInputBase-input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
            }}
          />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {TARGET_FLOOR_TEXT}
          </Typography>
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {TARGET_CAPTION}
        </Typography>
      </Stack>
    </Paper>
  );
}

/** What the moves of one way come to, to three decimals with its sign, and the exact amount on hover. */
function Total({ sign, total }: { sign: string; total: ChequebookTotal }) {
  return (
    <Box
      component="span"
      title={`${sign}${formatUnits(total.totalPlur, XBZZ_DECIMALS)} xBZZ`}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {`${sign}${formatShort(total.totalPlur, XBZZ_DECIMALS)} xBZZ`}
    </Box>
  );
}

/** What Apply would do, in a line: how many deposits and withdrawals, and what each way moves in all. */
function Summary({ check }: { check: ChequebookCheck }) {
  const { deposits, withdrawals } = check;
  return (
    <>
      {`To apply: ${depositCount(deposits.count)}`}
      {deposits.count > 0 ? (
        <>
          {', '}
          <Total sign="+" total={deposits} />
        </>
      ) : null}
      {`; ${withdrawalCount(withdrawals.count)}`}
      {withdrawals.count > 0 ? (
        <>
          {', '}
          <Total sign={MINUS} total={withdrawals} />
        </>
      ) : null}
      {'.'}
    </>
  );
}

/**
 * What Apply would do, why it cannot ask for it yet, Apply, and beside it Fund all while a ticked chequebook's node is
 * short of xBZZ for its deposit or has no xDAI for the gas: the nodes the bar names so.
 */
function ChequebookBar({
  check,
  blocked,
  onGo,
  onFund,
}: {
  check: ChequebookCheck;
  blocked: string | null;
  onGo: () => void;
  onFund: (needs: ReadonlyMap<string, FundNeed>) => void;
}) {
  // Said once each: two nodes that share a label would otherwise give the same sentence twice.
  const problems = [...new Set(blocked ? [...check.problems, blocked] : check.problems)];
  const needs = fundNeeds(check.ledgerOf);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="body2">
          <Summary check={check} />
        </Typography>
        {problems.map((problem) => (
          <Typography key={problem} variant="caption" sx={{ color: 'text.secondary' }}>
            {problem}
          </Typography>
        ))}
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={problems.length > 0} onClick={onGo}>
            Apply
          </Button>
          {needs.size > 0 ? (
            <Button variant="outlined" onClick={() => onFund(needs)}>
              Fund all
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  );
}

/**
 * The Chequebooks tab: bring the chequebooks of every stage's nodes to a target, each node paying from its own
 * wallet. Each stage's chequebooks are listed under its name; the catalogue node's is not, being of no use. Type the
 * target, tick chequebooks, and each ticked one shows its move: a deposit of the difference from its node's wallet when
 * it is under the target, a withdrawal of the difference into its node's wallet when it is over it, and no change at
 * it. Apply opens a confirm dialog, which reads the view again as it opens and asks for what that reading shows; each
 * operation is then followed until it comes to its end, and the view is read again once they have settled. While a
 * ticked chequebook's node is short of xBZZ for its deposit, or of xDAI for the gas, which its row says in red, Fund
 * all beside Apply opens the Balance tab with what each such node lacks entered. A gateway's chequebook is shown
 * read-only. A new chequebook bulk waits while one is on its way, the one made here or the one the view says is
 * open, which the page follows after a reload too. Select all, above the tables, ticks every chequebook that has a tick
 * box, and Clear unticks them all.
 *
 * The target and the ticks, `selection`, are the Funding page's, so they stay while another tab is shown; the
 * operations sent clear the ticks and keep the target. The tab reads the view again each time it is shown, and a tick
 * left on a chequebook that has lost its tick box since is neither counted nor asked for.
 */
export function ChequebooksTab({
  selection,
  onSelection,
  onFund,
}: {
  selection: ChequebookSelection;
  onSelection: Dispatch<SetStateAction<ChequebookSelection>>;
  /** Fund all: opens the Balance tab with what each of these nodes lacks entered. */
  onFund: (needs: ReadonlyMap<string, FundNeed>) => void;
}) {
  const { target, ticked } = selection;
  const [confirming, setConfirming] = useState(false);
  const [followed, setFollowed] = useState<FollowedBulk<FundingChequebookItem> | null>(null);

  const onRead = useCallback(
    (next: FundingView) => setFollowed((current) => followBulk(current, next.openChequebookBulkId)),
    [],
  );
  const read = useFundingView(onRead);
  const { view, load } = read;

  const groups = useMemo(() => (view ? chequebookGroups(view) : []), [view]);
  const movable = useMemo(() => [...new Set(groups.flatMap((group) => movableChequebooks(group)))], [groups]);
  const check = useMemo(() => (view ? checkChequebooks(view, selection) : null), [view, selection]);

  const onSettled = useCallback(() => {
    setFollowed((current) => current && { ...current, settled: true });
    load();
  }, [load]);

  const tick = useCallback(
    (nodeId: string) =>
      onSelection((current) => {
        const next = new Set(current.ticked);
        if (!next.delete(nodeId)) next.add(nodeId);
        return { ...current, ticked: next };
      }),
    [onSelection],
  );
  const setTicks = useCallback(
    (nodeIds: readonly string[], on: boolean) =>
      onSelection((current) => ({ ...current, ticked: withTicks(current.ticked, nodeIds, on) })),
    [onSelection],
  );
  const clearTicks = useCallback(() => onSelection((current) => ({ ...current, ticked: new Set() })), [onSelection]);
  const setTarget = (next: string) => onSelection((current) => ({ ...current, target: next }));

  /** Opens the confirm dialog and reads the view again, which the dialog lists what it asks for from. */
  const openConfirm = () => {
    setConfirming(true);
    load();
  };

  return (
    <Stack spacing={3}>
      <FundingFrame read={read} readLine={(ago) => `Chequebooks as the manager read them ${ago}.`} />

      {view?.configured ? (
        <>
          {followed ? (
            <ChequebookProgress
              key={followed.bulkId}
              bulkId={followed.bulkId}
              initial={followed.items}
              onSettled={onSettled}
              onDismiss={() => setFollowed(null)}
            />
          ) : null}
          <TargetControls target={target} onTarget={setTarget} />
          {groups.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {NO_STAGES}
              </Typography>
            </Paper>
          ) : null}
          {groups.length > 0 && !reportsChequebooks(view) ? (
            <Alert severity="info">{NO_CHEQUEBOOKS_REPORTED}</Alert>
          ) : null}
          {groups.length > 0 ? (
            <SelectAllBar keys={movable} ticked={ticked} onTicks={setTicks} onClear={clearTicks} />
          ) : null}
          {groups.map((group) => (
            <ChequebookTable key={group.key} group={group} ticked={ticked} check={check} onTick={tick} />
          ))}
          {check ? (
            <ChequebookBar
              check={check}
              blocked={followed && !followed.settled ? WAIT_FOR_CHEQUEBOOKS : null}
              onGo={openConfirm}
              onFund={onFund}
            />
          ) : null}
        </>
      ) : null}

      {confirming && check ? (
        <ChequebookDialog
          check={check}
          reading={read.loading}
          readError={read.error}
          onSent={(answer) => {
            setConfirming(false);
            clearTicks();
            setFollowed({ bulkId: answer.bulkId, items: answer.items, settled: false });
          }}
          onFailed={load}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </Stack>
  );
}
