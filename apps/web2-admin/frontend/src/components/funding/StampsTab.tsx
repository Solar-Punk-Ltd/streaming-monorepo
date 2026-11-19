import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Alert, Box, Button, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import {
  batchPurchaseHoldsNode,
  XBZZ_DECIMALS,
  type BatchBuyChoice,
  type FundingDiluteSteps,
  type FundingStampItem,
  type FundingStampOperationKind,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { purchaseRefusal } from '../archive/archiveText';
import { formatShort, formatUnits } from './amounts';
import { ArchiveStampsFooter, useArchiveStamps } from './ArchiveStamps';
import { fundNeeds, type FundNeed } from './balance';
import { BatchBuyDialog } from './BatchBuyDialog';
import { buyOfferOf, latestPurchases, purchasesReadFailed, useBatchPurchases, type BuyOffer } from './batchPurchases';
import { BatchTable, type BuyControls } from './BatchTable';
import { followBulk, type FollowedBulk } from './BulkProgress';
import { FundingFrame, useFundingView } from './FundingFrame';
import { StampDialog } from './StampDialog';
import { StampProgress } from './StampProgress';
import { DaysPicker } from './DaysPicker';
import {
  batchCount,
  batchGroups,
  checkStamps,
  dayCount,
  DAYS_MIN,
  readDays,
  reportsBatches,
  stepCount,
  tickableBatches,
  type StampCheck,
  type StampSelection,
} from './stamps';
import { SelectAllBar, withTicks } from './Ticks';

/** Said while a stamp bulk is still on its way, so a second one does not start before the first has settled. */
const WAIT_FOR_STAMPS = 'Wait for the stamp operations above to finish.';

/** The caption under the controls, whichever the operation: the times after are a quote. */
export const TODAYS_PRICE_CAPTION = "The time left after is at today's price.";

/** What the days of a top-up apply to, and who pays. */
export const TOP_UP_CAPTION = 'The days apply to every ticked batch, and each node pays for its own from its wallet.';

/** What the steps of a dilution apply to, what one does, and when it is refused. */
export const DILUTE_CAPTION =
  'The steps apply to every ticked batch. Each step doubles what a batch holds and halves its time left, and a dilution that would leave a batch under 7 days is refused.';

/** Said when the row a buy dialog was open on offers no purchase any more, and no refusal said why. */
export const ROW_OFFERS_NO_PURCHASE = 'That row offers no purchase now, so the dialog was closed.';

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
          <DaysPicker
            days={days}
            onDays={onDays}
            least={DAYS_MIN}
            sliderLabel="Days to top up by"
            problem={read.kind === 'invalid' ? read.problem : null}
          />
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

/**
 * What the ticked batches come to, why the operation cannot be asked for yet, the button that asks for it, and beside
 * it Fund all while a ticked batch's node is short of xBZZ or has no xDAI: the nodes the bar names so.
 */
function StampBar({
  check,
  operation,
  days,
  steps,
  blocked,
  onGo,
  onFund,
}: {
  check: StampCheck;
  operation: FundingStampOperationKind;
  days: string;
  steps: FundingDiluteSteps;
  blocked: string | null;
  onGo: () => void;
  onFund: (needs: ReadonlyMap<string, FundNeed>) => void;
}) {
  // Said once each: two nodes that share a label would otherwise give the same sentence twice.
  const problems = [...new Set(blocked ? [...check.problems, blocked] : check.problems)];
  const verb = operation === 'topup' ? 'Top up' : 'Dilute';
  const needs = fundNeeds(check.ledgerOf);
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
        <Stack direction="row" spacing={1}>
          {/* Always with its count, which also tells it from the operation switch's button of the same verb. */}
          <Button variant="contained" disabled={problems.length > 0} onClick={onGo}>
            {verb} {batchCount(check.lines.length)}
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
 * Buy new on the Stamps tab: the purchases, read with the view and again while one is under way; whether the catalogue
 * move is switched off, read from `GET /api/catalogue-stamp` with the view, since a catalogue purchase is put to use by
 * that move; the dialog's offer, its refusal and whether it is sending; and the controls the tables take. A purchase
 * that ends reads the view again, so its row shows the new batch. A refused purchase reads the view again too, and the
 * dialog's offer is built from each reading: still open with the refusal, the dialog prices the batch at the price the
 * manager reads now and names the batch the row shows now; once the row offers no purchase, it closes and the tab says
 * why.
 */
function useBuyNew(view: FundingView | null, load: () => void) {
  const purchases = useBatchPurchases(view, load);
  const { reload } = purchases;
  const [moveOff, setMoveOff] = useState(false);
  // The node the dialog is open on. Its offer is built from each reading of the page, so a purchase refused because
  // the row changed is asked for again with what the page shows now.
  const [buyingNodeId, setBuyingNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!view?.configured) return undefined;
    let current = true;
    api
      .fetchCatalogueState()
      .then(({ move }) => {
        if (current) setMoveOff(move?.enabled === false);
      })
      // Not read, the row offers Buy new, and the API refuses a purchase the move cannot follow.
      .catch(() => {
        if (current) setMoveOff(false);
      });
    return () => {
      current = false;
    };
  }, [view]);

  const latest = useMemo(() => latestPurchases(purchases.purchases ?? []), [purchases.purchases]);
  const catalogueNodeId = view?.catalogue?.nodeId ?? null;

  const offer: BuyOffer | null = useMemo(() => {
    if (buyingNodeId === null || !view) return null;
    const node = [view.catalogue, ...view.stages.flatMap((stage) => stage.nodes)].find(
      (each) => each?.nodeId === buyingNodeId,
    );
    const held = latest.get(buyingNodeId);
    if (!node || (held && batchPurchaseHoldsNode(held))) return null;
    return buyOfferOf(node, catalogueNodeId);
  }, [buyingNodeId, view, latest, catalogueNodeId]);

  // The row the dialog was opened on offers no purchase in this reading of the page: the dialog closes, and the tab
  // says why, in the refusal that led to the reading when there was one.
  useEffect(() => {
    if (buyingNodeId === null || offer !== null) return;
    setBuyingNodeId(null);
    setNotice(refusal ?? ROW_OFFERS_NO_PURCHASE);
    setRefusal(null);
  }, [buyingNodeId, offer, refusal]);

  const controls: BuyControls = useMemo(
    () => ({
      offerOf: (node) => buyOfferOf(node, catalogueNodeId),
      purchaseOf: (nodeId) => latest.get(nodeId),
      moveOff,
      onBuy: (next) => {
        setRefusal(null);
        setNotice(null);
        setBuyingNodeId(next.node.nodeId);
      },
      onRestart: async (purchaseId, stageId) => {
        await api.restartPurchaseStage(purchaseId, stageId);
        reload();
      },
      onCheck: async (purchaseId) => {
        await api.checkPurchaseAgain(purchaseId);
        reload();
      },
    }),
    [catalogueNodeId, latest, moveOff, reload],
  );

  const confirm = async (choice: BatchBuyChoice) => {
    if (!offer) return;
    setBusy(true);
    setRefusal(null);
    try {
      await api.buyBatch({
        ...choice,
        purpose: offer.purpose,
        nodeId: offer.node.nodeId,
        replacesBatchId: offer.replacesBatchId,
      });
      setBuyingNodeId(null);
      reload();
    } catch (e: unknown) {
      setRefusal(purchaseRefusal(e));
      load();
    } finally {
      setBusy(false);
    }
  };

  // Said only where it matters: while a row offers Buy new, or once purchases were read and are now out of date.
  const offers = view
    ? [view.catalogue, ...view.stages.flatMap((stage) => stage.nodes)].some(
        (node) => node !== null && buyOfferOf(node, catalogueNodeId) !== null,
      )
    : false;
  const readError = purchases.error && (offers || purchases.purchases !== null) ? purchases.error : null;

  return {
    controls,
    offer,
    busy,
    refusal,
    confirm,
    close: () => setBuyingNodeId(null),
    readError,
    notice,
    clearNotice: () => setNotice(null),
  };
}

/**
 * The Stamps tab: top up or dilute the batches the nodes upload with, each node paying from its own wallet. The
 * catalogue batch comes on top, then the archive stamps from `GET /api/archive/stamps`, with their room and the
 * qualities on them and "Buy archive stamp" under them, then each stage's batches. Each archive stamp is paid for by
 * the node that holds it, the catalogue node for every stamp bought here, so that node's one wallet pays for them and
 * for the catalogue batch, and its rows' wallet after counts them all. Tick batches, choose the days or the steps, which apply to
 * every ticked one, and confirm, in a dialog that reads the view again as it opens and asks for what that reading
 * shows; each operation is then followed until it comes to its end, and the view is read again once they have
 * settled. A ticked batch shows what it costs and leaves, and its node's xBZZ after, or in red what it lacks for its
 * top-ups. While a ticked batch's node is short of xBZZ or has no xDAI for the gas, Fund all beside the button opens
 * the Balance tab with what each such node lacks entered. A new stamp bulk waits while one is on its way, the one made
 * here or the one the view says is open, which the page follows after a reload too. Switching the operation clears the
 * ticks, since a dilution cannot be undone. Select all, above the tables, ticks every batch that has a tick box, the
 * catalogue's among them, and Clear unticks them all; the tick box in front of a group's name ticks or clears the
 * group's.
 *
 * A batch that no longer pays, expired or gone from its node, and a node with no batch, offer Buy new in their row
 * instead, which buys its replacement in a dialog of its own; the purchase is followed under the row, stage by stage
 * or through the catalogue's move. `docs/architecture/funding.md`, "Buying a new batch".
 *
 * The operation, the days, the steps and the ticks, `selection`, are the Funding page's, so they stay while another
 * tab is shown; the operations sent clear the ticks. The tab reads the view again each time it is shown, and a tick
 * left on a batch that has lost its tick box since is neither counted nor asked for.
 */
export function StampsTab({
  selection,
  onSelection,
  onFund,
}: {
  selection: StampSelection;
  onSelection: Dispatch<SetStateAction<StampSelection>>;
  /** Fund all: opens the Balance tab with what each of these nodes lacks entered. */
  onFund: (needs: ReadonlyMap<string, FundNeed>) => void;
}) {
  const { operation, days, steps, ticked } = selection;
  const [confirming, setConfirming] = useState(false);
  const [followed, setFollowed] = useState<FollowedBulk<FundingStampItem> | null>(null);

  const onRead = useCallback(
    (next: FundingView) => setFollowed((current) => followBulk(current, next.openStampBulkId)),
    [],
  );
  const read = useFundingView(onRead);
  const { view, load } = read;

  // Read with the view, so a purchase that has turned into a batch is listed with what the admin knows of it.
  const archive = useArchiveStamps(view, load);
  // The view's batches and the archive stamps, each stamp with the node that holds it, which pays for it.
  const inventory = useMemo(
    () => (view ? { ...view, archiveStamps: archive.stamps?.stamps ?? [] } : null),
    [view, archive.stamps],
  );
  const groups = useMemo(() => (inventory ? batchGroups(inventory) : []), [inventory]);
  const buyNew = useBuyNew(view, load);
  const tickable = useMemo(
    () => [...new Set(groups.flatMap((group) => tickableBatches(group, operation)))],
    [groups, operation],
  );
  const check = useMemo(() => (inventory ? checkStamps(inventory, selection) : null), [inventory, selection]);

  const onSettled = useCallback(() => {
    setFollowed((current) => current && { ...current, settled: true });
    load();
  }, [load]);

  const tick = useCallback(
    (batchId: string) =>
      onSelection((current) => {
        const next = new Set(current.ticked);
        if (!next.delete(batchId)) next.add(batchId);
        return { ...current, ticked: next };
      }),
    [onSelection],
  );
  const setTicks = useCallback(
    (batchIds: readonly string[], on: boolean) =>
      onSelection((current) => ({ ...current, ticked: withTicks(current.ticked, batchIds, on) })),
    [onSelection],
  );
  const clearTicks = useCallback(() => onSelection((current) => ({ ...current, ticked: new Set() })), [onSelection]);

  const switchOperation = (next: FundingStampOperationKind) =>
    onSelection((current) => ({ ...current, operation: next, ticked: new Set() }));
  const setDays = (next: string) => onSelection((current) => ({ ...current, days: next }));
  const setSteps = (next: FundingDiluteSteps) => onSelection((current) => ({ ...current, steps: next }));

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
          {buyNew.readError ? <Alert severity="warning">{purchasesReadFailed(buyNew.readError)}</Alert> : null}
          {buyNew.notice ? (
            <Alert severity="info" onClose={buyNew.clearNotice}>
              {buyNew.notice}
            </Alert>
          ) : null}
          {groups.length > 0 ? (
            <SelectAllBar keys={tickable} ticked={ticked} onTicks={setTicks} onClear={clearTicks} />
          ) : null}
          {groups.map((group) => (
            <BatchTable
              key={group.key}
              group={group}
              operation={operation}
              ticked={ticked}
              check={check}
              onTick={tick}
              onTicks={setTicks}
              {...(group.kind === 'archive'
                ? {
                    warningDays: archive.stamps?.ttlWarningDays ?? null,
                    footer: <ArchiveStampsFooter read={archive} onBought={load} />,
                  }
                : { buy: buyNew.controls })}
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
              onFund={onFund}
            />
          ) : null}
        </>
      ) : null}

      {buyNew.offer ? (
        <BatchBuyDialog
          open
          offer={buyNew.offer}
          postage={view?.postage ?? null}
          busy={buyNew.busy}
          refusal={buyNew.refusal}
          onConfirm={(choice) => void buyNew.confirm(choice)}
          onClose={buyNew.close}
          onFund={onFund}
        />
      ) : null}

      {confirming && check ? (
        <StampDialog
          operation={operation}
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
