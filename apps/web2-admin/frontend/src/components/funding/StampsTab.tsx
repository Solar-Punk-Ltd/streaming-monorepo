import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  InputAdornment,
  Paper,
  Slider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  XBZZ_DECIMALS,
  type FundingDiluteSteps,
  type FundingStampItem,
  type FundingStampOperationKind,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import { formatShort, formatUnits } from './amounts';
import { BatchTable } from './BatchTable';
import { followBulk, type FollowedBulk } from './BulkProgress';
import { FundingFrame, useFundingView } from './FundingFrame';
import { StampDialog } from './StampDialog';
import { StampProgress } from './StampProgress';
import {
  acceptsDaysTyping,
  batchCount,
  batchGroups,
  checkStamps,
  dayCount,
  DAYS_MIN,
  DAYS_PRESETS,
  DAYS_SLIDER_MAX,
  DEFAULT_DAYS,
  readDays,
  reportsBatches,
  stepCount,
  type StampCheck,
} from './stamps';

/** Said while a stamp bulk is still on its way, so a second one does not start before the first has settled. */
const WAIT_FOR_STAMPS = 'Wait for the stamp operations above to finish.';

/** The caption under the controls, whichever the operation: the times after are a quote. */
export const TODAYS_PRICE_CAPTION = "The time left after is at today's price.";

/** What the days of a top-up apply to, and who pays. */
export const TOP_UP_CAPTION = 'The days apply to every ticked batch, and each node pays for its own from its wallet.';

/** What the steps of a dilution apply to, what one does, and when it is refused. */
export const DILUTE_CAPTION =
  'The steps apply to every ticked batch. Each step doubles what a batch holds and halves its time left, and a dilution that would leave a batch under 7 days is refused.';

/** Said when the manager names no node's batch at all, as one older than the Stamps tab answers. */
export const NO_BATCHES_REPORTED =
  "The manager does not report its nodes' batches. A manager older than this page does not read them.";

/**
 * The operation, then what it takes: for a top-up, the days, on a slider from 1 to 365 with three presets and a field
 * that takes any whole number of days from 1; for a dilution, one step or two. Either applies to every ticked batch.
 */
function StampControls({
  operation,
  onOperation,
  days,
  onDays,
  steps,
  onSteps,
}: {
  operation: FundingStampOperationKind;
  onOperation: (operation: FundingStampOperationKind) => void;
  days: string;
  onDays: (days: string) => void;
  steps: FundingDiluteSteps;
  onSteps: (steps: FundingDiluteSteps) => void;
}) {
  const read = readDays(days);
  const slider = read.kind === 'ok' ? Math.min(read.days, DAYS_SLIDER_MAX) : DAYS_MIN;
  const preset = read.kind === 'ok' && DAYS_PRESETS.includes(read.days) ? read.days : null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <ToggleButtonGroup
          exclusive
          size="small"
          color="primary"
          value={operation}
          aria-label="Operation"
          onChange={(_event, next: FundingStampOperationKind | null) => {
            if (next) onOperation(next);
          }}
        >
          <ToggleButton value="topup">Top up</ToggleButton>
          <ToggleButton value="dilute">Dilute</ToggleButton>
        </ToggleButtonGroup>

        {operation === 'topup' ? (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: { md: 'center' } }}>
            <Slider
              aria-label="Days to top up by"
              min={DAYS_MIN}
              max={DAYS_SLIDER_MAX}
              value={slider}
              marks={DAYS_PRESETS.map((value) => ({ value }))}
              valueLabelDisplay="auto"
              onChange={(_event, value) => {
                if (typeof value === 'number') onDays(String(value));
              }}
              sx={{ flexGrow: 1, minWidth: 200 }}
            />
            <ToggleButtonGroup
              exclusive
              size="small"
              value={preset}
              aria-label="Days presets"
              onChange={(_event, next: number | null) => {
                if (next !== null) onDays(String(next));
              }}
            >
              {DAYS_PRESETS.map((value) => (
                <ToggleButton key={value} value={value}>
                  {dayCount(value)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <TextField
              size="small"
              value={days}
              onChange={(e) => {
                if (acceptsDaysTyping(e.target.value)) onDays(e.target.value);
              }}
              error={read.kind === 'invalid'}
              title={read.kind === 'invalid' ? read.problem : undefined}
              slotProps={{
                htmlInput: { inputMode: 'numeric', 'aria-label': 'Days' },
                input: { endAdornment: <InputAdornment position="end">days</InputAdornment> },
              }}
              sx={{
                width: 140,
                flexShrink: 0,
                '& .MuiInputBase-input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
              }}
            />
          </Stack>
        ) : (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={steps}
            aria-label="Steps"
            onChange={(_event, next: FundingDiluteSteps | null) => {
              if (next !== null) onSteps(next);
            }}
          >
            <ToggleButton value={1}>1 step</ToggleButton>
            <ToggleButton value={2}>2 steps</ToggleButton>
          </ToggleButtonGroup>
        )}

        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {operation === 'topup' ? TOP_UP_CAPTION : DILUTE_CAPTION}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {TODAYS_PRICE_CAPTION}
          </Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}

/**
 * What the ticked batches come to, in a line: a top-up's total in xBZZ to three decimals, as the rows have their
 * amounts, with the exact amount on hover.
 */
function Summary({
  check,
  operation,
  days,
  steps,
}: {
  check: StampCheck;
  operation: FundingStampOperationKind;
  days: string;
  steps: FundingDiluteSteps;
}) {
  const batches = batchCount(check.lines.length);
  if (operation === 'dilute') return <>{`To dilute: ${batches}, ${stepCount(steps)} deeper each.`}</>;
  const read = readDays(days);
  const each = read.kind === 'ok' ? `, ${dayCount(read.days)} more each` : '';
  if (check.totalCostPlur === null) return <>{`To top up: ${batches}${each}.`}</>;
  return (
    <>
      {`To top up: ${batches}${each}, `}
      <Box
        component="span"
        title={`${formatUnits(check.totalCostPlur, XBZZ_DECIMALS)} xBZZ`}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {`${formatShort(check.totalCostPlur, XBZZ_DECIMALS)} xBZZ`}
      </Box>
      {' in all.'}
    </>
  );
}

/** What the ticked batches come to, why the operation cannot be asked for yet, and the button that asks for it. */
function StampBar({
  check,
  operation,
  days,
  steps,
  blocked,
  onGo,
}: {
  check: StampCheck;
  operation: FundingStampOperationKind;
  days: string;
  steps: FundingDiluteSteps;
  blocked: string | null;
  onGo: () => void;
}) {
  // Said once each: two nodes that share a label would otherwise give the same sentence twice.
  const problems = [...new Set(blocked ? [...check.problems, blocked] : check.problems)];
  const verb = operation === 'topup' ? 'Top up' : 'Dilute';
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="body2">
          <Summary check={check} operation={operation} days={days} steps={steps} />
        </Typography>
        {problems.map((problem) => (
          <Typography key={problem} variant="caption" sx={{ color: 'text.secondary' }}>
            {problem}
          </Typography>
        ))}
        <Stack direction="row">
          {/* Always with its count, which also tells it from the operation switch's button of the same verb. */}
          <Button variant="contained" disabled={problems.length > 0} onClick={onGo}>
            {verb} {batchCount(check.lines.length)}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

/**
 * The Stamps tab: top up or dilute the batches the nodes upload with, each node paying from its own wallet. The
 * catalogue batch comes on top, then each stage's batches. Tick batches, choose the days or the steps, which apply to
 * every ticked one, and confirm, in a dialog that reads the view again as it opens and asks for what that reading
 * shows; each operation is then followed until it comes to its end, and the view is read again once they have
 * settled. A ticked batch shows what it costs and leaves, and its node's xBZZ after; a node short of xBZZ for its
 * top-ups has a Fund link to the Balance tab, with what it lacks entered. A new stamp bulk waits while one is on its
 * way, the one made here or the one the view says is open, which the page follows after a reload too. Switching the
 * operation clears the ticks, since a dilution cannot be undone.
 */
export function StampsTab({ onFund }: { onFund: (nodeId: string, xbzzPlur: string) => void }) {
  const [operation, setOperation] = useState<FundingStampOperationKind>('topup');
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [steps, setSteps] = useState<FundingDiluteSteps>(1);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [followed, setFollowed] = useState<FollowedBulk<FundingStampItem> | null>(null);

  const onRead = useCallback(
    (next: FundingView) => setFollowed((current) => followBulk(current, next.openStampBulkId)),
    [],
  );
  const read = useFundingView(onRead);
  const { view, load } = read;

  const groups = useMemo(() => (view ? batchGroups(view) : []), [view]);
  const check = useMemo(
    () => (view ? checkStamps(view, { operation, days, steps, ticked }) : null),
    [view, operation, days, steps, ticked],
  );

  const onSettled = useCallback(() => {
    setFollowed((current) => current && { ...current, settled: true });
    load();
  }, [load]);

  const tick = useCallback(
    (batchId: string) =>
      setTicked((current) => {
        const next = new Set(current);
        if (!next.delete(batchId)) next.add(batchId);
        return next;
      }),
    [],
  );

  const switchOperation = (next: FundingStampOperationKind) => {
    setOperation(next);
    setTicked(new Set());
  };

  /** Opens the confirm dialog and reads the view again, which the dialog lists what it asks for from. */
  const openConfirm = () => {
    setConfirming(true);
    load();
  };

  return (
    <Stack spacing={3}>
      <FundingFrame read={read} readLine={(ago) => `Batches as the manager read them ${ago}.`} />

      {view?.configured ? (
        <>
          {followed ? (
            <StampProgress
              key={followed.bulkId}
              bulkId={followed.bulkId}
              initial={followed.items}
              onSettled={onSettled}
              onDismiss={() => setFollowed(null)}
            />
          ) : null}
          <StampControls
            operation={operation}
            onOperation={switchOperation}
            days={days}
            onDays={setDays}
            steps={steps}
            onSteps={setSteps}
          />
          {groups.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                The manager reports no nodes yet.
              </Typography>
            </Paper>
          ) : null}
          {groups.length > 0 && !reportsBatches(view) ? <Alert severity="info">{NO_BATCHES_REPORTED}</Alert> : null}
          {groups.map((group) => (
            <BatchTable
              key={group.key}
              group={group}
              operation={operation}
              ticked={ticked}
              check={check}
              onTick={tick}
              onFund={onFund}
            />
          ))}
          {check ? (
            <StampBar
              check={check}
              operation={operation}
              days={days}
              steps={steps}
              blocked={followed && !followed.settled ? WAIT_FOR_STAMPS : null}
              onGo={openConfirm}
            />
          ) : null}
        </>
      ) : null}

      {confirming && check ? (
        <StampDialog
          operation={operation}
          check={check}
          reading={read.loading}
          readError={read.error}
          onSent={(answer) => {
            setConfirming(false);
            setTicked(new Set());
            setFollowed({ bulkId: answer.bulkId, items: answer.items, settled: false });
          }}
          onFailed={load}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </Stack>
  );
}
