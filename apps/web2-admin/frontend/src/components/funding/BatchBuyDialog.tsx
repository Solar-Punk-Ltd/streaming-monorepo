import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  BATCH_BUY_DEFAULT_DAYS,
  BATCH_BUY_MIN_DAYS,
  batchBuyDepthRange,
  batchBuyProblem,
  batchBuyQuote,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  type BatchBuyChoice,
  type BatchBuyQuote,
  type FundingPostage,
} from '@streaming-monorepo/web2-admin-common';

import { formatTimeLeft, shortHex } from '../../format';
import { chunkCount, formatCapacity } from '../archive/archiveText';
import { formatShort, formatUnits, roundUpUnits } from './amounts';
import type { FundNeed } from './balance';
import type { BuyOffer } from './batchPurchases';
import { DaysPicker, readDaysFrom } from './DaysPicker';
import { DepthRows, type DepthRow } from './DepthRows';
import { dayCount } from './stamps';

/** Why the days typed cannot be priced. */
export const BUY_DAYS_PROBLEM = `The days are a whole number, ${BATCH_BUY_MIN_DAYS} or more.`;

/** Said under the days: the least a new batch lasts, and that the days are bought at today's price. */
export const BUY_DAYS_CAPTION = `At least ${dayCount(BATCH_BUY_MIN_DAYS)}. The life is bought at today's price; a price that rises shortens it.`;

/** What the kinds of a rung's batch do. */
export const KIND_CAPTION =
  'An immutable batch refuses an upload into a full bucket. A mutable one takes it, and overwrites the oldest chunks of that bucket.';

/** Said in place of the kind for the catalogue. */
export const CATALOGUE_KIND_CAPTION = 'The catalogue is written with an immutable batch.';

/** Said on the confirm step: who pays, and why no password is asked. */
export function paysNote(nodeLabel: string): string {
  return `${nodeLabel} pays from its own wallet, in xBZZ, and the gas in xDAI. Nothing leaves the brand wallet, so no password is asked.`;
}

/** Said on the confirm step: what happens once the batch is bought, by itself. */
export const FOLLOW_UP_TEXT = {
  rung: "Once the batch is usable, the manager sets it on the rung and restarts the uploader of each stage that follows it, a stage at a time, when no broadcast is live there. This row shows each stage's line.",
  catalogue:
    'Once the batch is usable, the manager designates it, the admin moves the catalogue onto it, and the manager then releases the previous batch. This row shows the move.',
} as const;

function xbzz(plur: string): string {
  return `${formatShort(plur, XBZZ_DECIMALS)} xBZZ`;
}

function kindName(immutable: boolean): string {
  return immutable ? 'immutable' : 'mutable';
}

/** The manager's recommendation, in a line: the depth and kind of the batch it replaces, when there is one. */
export function recommendationLine(depth: number, immutable: boolean, replaces: boolean): string {
  const like = replaces ? ', as the batch it replaces' : '';
  return `Recommended: depth ${depth}, ${kindName(immutable)}, ${dayCount(BATCH_BUY_DEFAULT_DAYS)}${like}.`;
}

/** What the paying node's wallet holds, in a sentence, or that it could not be read. */
function walletLine(label: string, xbzzPlur: string | null, xdaiWei: string | null): string {
  if (xbzzPlur === null || xdaiWei === null) {
    return `The wallet of ${label} could not be read. The manager checks it again before buying.`;
  }
  return `The wallet of ${label} holds ${xbzz(xbzzPlur)} and ${formatShort(xdaiWei, XDAI_DECIMALS)} xDAI.`;
}

/**
 * What the picked depth comes to, in a line: its life at today's price, what it holds before its fullest bucket fills,
 * and what it costs.
 */
export function quoteLine(quote: BatchBuyQuote): string {
  return `Lasts ${formatTimeLeft(quote.ttlSeconds)} at today's price, holds ${formatCapacity(quote.effectiveBytes)} (${chunkCount(quote.effectiveChunks)}), and costs ${xbzz(quote.costPlur)} plus the gas.`;
}

export interface BatchBuyDialogProps {
  offer: BuyOffer;
  /** Today's price, from the Funding view, or null when it was not read. */
  postage: FundingPostage | null;
  /** True while the choice is being sent, when the dialog takes no second confirm. */
  busy: boolean;
  /** The API's sentence when it refused the choice, or null: the new cost when the price moved, what the wallet lacks. */
  refusal: string | null;
  /** The user confirmed this choice, after the confirm step that names its cost. The caller sends it. */
  onConfirm: (choice: BatchBuyChoice) => void;
  onClose: () => void;
  /** Opens the Balance tab with what the node lacks entered, as Fund all does. */
  onFund?: (needs: ReadonlyMap<string, FundNeed>) => void;
}

/** The dialog's content, mounted afresh each time it opens, so a second purchase starts from the recommendation. */
function BuyBody({ offer, postage, busy, refusal, onConfirm, onClose, onFund }: BatchBuyDialogProps) {
  const { node, purpose, replacesBatchId } = offer;
  const [least, most] = batchBuyDepthRange(purpose);
  const recommended = node.replacement ?? { depth: least, immutable: true };
  const startDepth = Math.min(most, Math.max(least, recommended.depth));
  const startImmutable = purpose === 'catalogue' ? true : recommended.immutable;
  const [daysText, setDaysText] = useState(String(BATCH_BUY_DEFAULT_DAYS));
  const [depth, setDepth] = useState(startDepth);
  const [immutable, setImmutable] = useState(startImmutable);
  const [confirming, setConfirming] = useState(false);

  const days = readDaysFrom(daysText, BATCH_BUY_MIN_DAYS);
  const quoteAt = (d: number) =>
    days !== null && postage !== null
      ? batchBuyQuote({ depth: d, days, postage, walletXbzzPlur: node.xbzzPlur })
      : null;
  const rows: DepthRow[] = [];
  for (let d = least; d <= most; d += 1) {
    const q = quoteAt(d);
    if (q) rows.push({ depth: d, bytes: q.effectiveBytes, chunks: q.effectiveChunks, costPlur: q.costPlur });
  }
  const quote = quoteAt(depth);
  const choice: BatchBuyChoice | null =
    quote && days !== null ? { depth, immutable, days, costPlur: quote.costPlur } : null;
  const terms = { postage, walletXbzzPlur: node.xbzzPlur, walletXdaiWei: node.xdaiWei };
  const problem =
    days === null
      ? BUY_DAYS_PROBLEM
      : batchBuyProblem(purpose, choice ?? { depth, immutable, days, costPlur: '0' }, terms);
  const changed = days !== BATCH_BUY_DEFAULT_DAYS || depth !== startDepth || immutable !== startImmutable;
  const close = busy ? undefined : onClose;
  const title = purpose === 'catalogue' ? 'Buy a new catalogue batch' : `Buy a new batch for ${node.label}`;

  if (confirming && choice && quote && days !== null) {
    const replaces = replacesBatchId ? `, in place of batch ${shortHex(replacesBatchId)}` : '';
    return (
      <Dialog open onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>Buy this batch?</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2">
              {`A ${kindName(immutable)} batch of depth ${depth}, holding ${formatCapacity(quote.effectiveBytes)}, for ${dayCount(days)} at today's price, on ${node.label}${replaces}.`}
            </Typography>
            <Typography variant="body1">
              It costs{' '}
              <Box component="strong" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {`${formatUnits(quote.costPlur, XBZZ_DECIMALS)} xBZZ`}
              </Box>
              , plus the gas.
            </Typography>
            <Typography variant="body2">{FOLLOW_UP_TEXT[purpose]}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {paysNote(node.label)}
            </Typography>
            {refusal ? <Alert severity="error">{refusal}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)} disabled={busy}>
            Back
          </Button>
          <Button
            variant="contained"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : null}
            onClick={() => onConfirm(choice)}
          >
            {`Buy for ${xbzz(quote.costPlur)}`}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  const shortfall = quote?.shortfallPlur ?? null;
  const noGas = node.xdaiWei !== null && BigInt(node.xdaiWei) === 0n;
  const fund =
    onFund && (shortfall !== null || noGas)
      ? () =>
          onFund(
            new Map([
              [
                node.nodeId,
                {
                  fundPlur: shortfall === null ? null : roundUpUnits(BigInt(shortfall), XBZZ_DECIMALS).toString(),
                  noGas,
                },
              ],
            ]),
          )
      : null;

  return (
    <Dialog open onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2">
            {replacesBatchId
              ? `It takes the place of batch ${shortHex(replacesBatchId)}, which no longer pays for uploads.`
              : `${node.label} has no batch set. This is its first.`}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {recommendationLine(startDepth, startImmutable, replacesBatchId !== null)}
            </Typography>
            {changed ? (
              <Button
                size="small"
                disabled={busy}
                onClick={() => {
                  setDaysText(String(BATCH_BUY_DEFAULT_DAYS));
                  setDepth(startDepth);
                  setImmutable(startImmutable);
                }}
              >
                Use it
              </Button>
            ) : null}
          </Stack>

          {purpose === 'rung' ? (
            <Stack spacing={0.5}>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={immutable}
                disabled={busy}
                aria-label="Kind"
                onChange={(_event, next: boolean | null) => {
                  if (next !== null) setImmutable(next);
                }}
              >
                <ToggleButton value={false}>Mutable</ToggleButton>
                <ToggleButton value>Immutable</ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {KIND_CAPTION}
              </Typography>
            </Stack>
          ) : (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {CATALOGUE_KIND_CAPTION}
            </Typography>
          )}

          <Stack spacing={0.5}>
            <DaysPicker
              days={daysText}
              onDays={setDaysText}
              least={BATCH_BUY_MIN_DAYS}
              sliderLabel="Days the batch lasts"
              problem={days === null ? BUY_DAYS_PROBLEM : null}
              disabled={busy}
            />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {BUY_DAYS_CAPTION}
            </Typography>
          </Stack>

          {rows.length > 0 ? (
            <DepthRows rows={rows} depth={depth} onPick={setDepth} disabled={busy} scrollToPicked />
          ) : null}
          {quote ? <Typography variant="body2">{quoteLine(quote)}</Typography> : null}
          <Typography variant="body2">{walletLine(node.label, node.xbzzPlur, node.xdaiWei)}</Typography>
          {shortfall !== null ? (
            <Typography
              variant="body2"
              sx={{ color: 'error.main' }}
              title={`${formatUnits(shortfall, XBZZ_DECIMALS)} xBZZ`}
            >
              {`Short ${xbzz(roundUpUnits(BigInt(shortfall), XBZZ_DECIMALS).toString())} for this batch.`}
            </Typography>
          ) : null}
          {problem ? (
            <Alert
              severity="warning"
              action={
                fund ? (
                  <Button color="inherit" size="small" onClick={fund}>
                    Fund it
                  </Button>
                ) : undefined
              }
            >
              {problem}
            </Alert>
          ) : null}
          {refusal ? <Alert severity="error">{refusal}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || problem !== null || choice === null}
          onClick={() => setConfirming(true)}
        >
          {quote ? `Next: ${xbzz(quote.costPlur)}` : 'Next'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Buy new's dialog, for a rung's batch or the catalogue's that no longer pays. It opens on the manager's
 * recommendation, the depth and kind of the batch it replaces and {@link BATCH_BUY_DEFAULT_DAYS} days, with a way back
 * to it once changed. The calculator is the Stamps tab's days and the buy dialogs' depth rows, priced with the common
 * `batchBuyQuote`: each depth's size and cost for the days, then for the picked one its life at today's price, the
 * paying node's wallet and what it is short of, with Fund it, which opens the Balance tab with that entered. The common
 * `batchBuyProblem` says why a choice cannot be bought. A confirm step names the batch, the exact cost and what follows
 * the purchase before `onConfirm`, whose choice carries the cost, so the API refuses it when the price moved. The dialog
 * sends nothing itself, and shows the caller's `refusal`.
 */
export function BatchBuyDialog({ open, ...props }: BatchBuyDialogProps & { open: boolean }) {
  return open ? <BuyBody {...props} /> : null;
}
