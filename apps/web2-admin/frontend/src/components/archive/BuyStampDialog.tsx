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
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  ARCHIVE_ROOM_MARGIN,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  archiveBuyProblem,
  archiveBuyQuote,
  type ArchiveBuyChoice,
  type ArchiveBuyTerms,
} from '@streaming-monorepo/web2-admin-common';

import { formatShort, formatUnits } from '../funding/amounts';
import { DepthRows } from '../funding/DepthRows';
import { dayCount } from '../funding/stamps';
import type { BuyStampDialogProps } from './archiveSeams';
import { chunkCount, formatCapacity } from './archiveText';

/** The most characters a stamp's label takes once trimmed, as `ArchiveBuyChoice.label` says. */
export const LABEL_MAX_LENGTH = 64;

/** Said under the days: the least a new stamp lasts, and that the days are bought at today's price. */
export function daysCaption(minimumDays: number): string {
  return `At least ${dayCount(minimumDays)}. The life is bought at today's price; the node reports the life it got.`;
}

/** Why the days typed cannot be priced. */
export function daysProblem(minimumDays: number): string {
  return `The days are a whole number, ${minimumDays} or more.`;
}

/** Said when the price of postage was not read, so no depth can be priced. */
export const NO_PRICE_TEXT = 'The price of postage could not be read, so no stamp can be priced now.';

/** Said when no depth of the table holds the recording. */
export const NOTHING_HOLDS_IT = 'No archive stamp is deep enough to hold this recording.';

/** Said on the confirm step: who pays, and why no password is asked. */
export const PAYS_NOTE =
  'The catalogue node pays from its own wallet, in xBZZ, and the gas in xDAI. Nothing leaves the brand wallet, so no password is asked.';

/** Said under the rows with a recording: what the default is, and that a bigger stamp can be chosen. */
export function sizedFor(chunksNeeded: number): string {
  return `This recording needs ${chunkCount(chunksNeeded)} with the ${Math.round(ARCHIVE_ROOM_MARGIN * 100)}% margin. The smallest stamp that holds it is chosen; a deeper one leaves room for more.`;
}

/** The days typed, as a whole number of `minimumDays` or more, or null. */
function readBuyDays(typed: string, minimumDays: number): number | null {
  if (!/^\d{1,5}$/.test(typed.trim())) return null;
  const days = Number(typed.trim());
  return days >= minimumDays ? days : null;
}

/** What the catalogue node's wallet holds, in a sentence, or that it could not be read. */
function walletLine(terms: ArchiveBuyTerms): string {
  if (terms.walletXbzzPlur === null || terms.walletXdaiWei === null) {
    return "The catalogue node's wallet could not be read. The manager checks it again before buying.";
  }
  const xbzz = formatShort(terms.walletXbzzPlur, XBZZ_DECIMALS);
  const xdai = formatShort(terms.walletXdaiWei, XDAI_DECIMALS);
  return `The catalogue node's wallet holds ${xbzz} xBZZ and ${xdai} xDAI.`;
}

function xbzz(plur: string): string {
  return `${formatShort(plur, XBZZ_DECIMALS)} xBZZ`;
}

/** The dialog's content, mounted afresh each time it opens, so a second purchase starts from the defaults again. */
function BuyDialogBody({
  terms,
  chunkCount: measured,
  busy,
  refusal,
  onConfirm,
  onClose,
}: Omit<BuyStampDialogProps, 'open'>) {
  const chunks = measured ?? null;
  const [daysText, setDaysText] = useState(String(terms.defaultDays));
  const [picked, setPicked] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [confirming, setConfirming] = useState(false);

  const days = readBuyDays(daysText, terms.minimumDays);
  const quote =
    days !== null && terms.postage !== null ? archiveBuyQuote({ chunks, days, postage: terms.postage }) : null;
  // A depth picked stays picked while the days change; one the rows no longer offer falls back to the default.
  const depth = quote ? (quote.rows.some((row) => row.depth === picked) ? picked : quote.defaultDepth) : null;
  const row = quote?.rows.find((r) => r.depth === depth) ?? null;
  const choice: ArchiveBuyChoice | null =
    row && days !== null
      ? { depth: row.depth, days, label: label.trim() === '' ? null : label.trim(), costPlur: row.costPlur }
      : null;

  let problem: string | null = null;
  if (days === null) problem = daysProblem(terms.minimumDays);
  else if (terms.postage === null) problem = NO_PRICE_TEXT;
  else if (quote && quote.rows.length === 0) problem = NOTHING_HOLDS_IT;
  else if (choice) problem = archiveBuyProblem(choice, terms, quote?.chunksNeeded ?? null);

  const close = busy ? undefined : onClose;

  if (confirming && choice && row && days !== null) {
    return (
      <Dialog open onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>Buy this archive stamp?</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2">
              {`A stamp of depth ${row.depth}, holding ${formatCapacity(row.effectiveBytes)} (${chunkCount(row.effectiveChunks)}), for ${dayCount(days)} at today's price${choice.label ? `, labelled “${choice.label}”` : ''}.`}
            </Typography>
            <Typography variant="body1">
              It costs{' '}
              <Box component="strong" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {`${formatUnits(row.costPlur, XBZZ_DECIMALS)} xBZZ`}
              </Box>
              , plus the gas.
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {PAYS_NOTE}
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
            {`Buy for ${xbzz(row.costPlur)}`}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Buy an archive stamp</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            size="small"
            label="Days"
            value={daysText}
            disabled={busy}
            onChange={(e) => {
              if (/^\d{0,5}$/.test(e.target.value)) setDaysText(e.target.value);
            }}
            error={days === null}
            helperText={daysCaption(terms.minimumDays)}
            slotProps={{
              htmlInput: { inputMode: 'numeric' },
              input: { endAdornment: <InputAdornment position="end">days</InputAdornment> },
            }}
            sx={{ maxWidth: 360 }}
          />
          {quote && quote.chunksNeeded !== null ? (
            <Typography variant="body2">{sizedFor(quote.chunksNeeded)}</Typography>
          ) : null}
          {quote && quote.rows.length > 0 ? (
            <DepthRows
              rows={quote.rows.map((r) => ({
                depth: r.depth,
                bytes: r.effectiveBytes,
                chunks: r.effectiveChunks,
                costPlur: r.costPlur,
              }))}
              depth={depth}
              onPick={setPicked}
              disabled={busy}
            />
          ) : null}
          <TextField
            size="small"
            label="Label (optional)"
            value={label}
            disabled={busy}
            onChange={(e) => setLabel(e.target.value.slice(0, LABEL_MAX_LENGTH))}
            helperText="Shown beside the stamp on the Stamps tab and the Archive page."
          />
          <Typography variant="body2">{walletLine(terms)}</Typography>
          {problem ? <Alert severity="warning">{problem}</Alert> : null}
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
          {row ? `Next: ${xbzz(row.costPlur)}` : 'Next'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The one buy dialog for an archive stamp, on the Stamps tab and in the archive panel: `archiveSeams.ts` says what it
 * takes. A row per depth, each with what it holds and costs for the days typed: with a recording's `chunkCount`, from
 * the smallest that holds it with the 5% margin, which it starts on, to the deepest; without one, every depth, starting
 * on the shallowest. The days start at the default and are 2 or more. A confirm step names the depth and the exact
 * cost before `onConfirm`, whose choice carries the depth, the days, the label and that cost, so the API can refuse it
 * when the price moved. The dialog sends nothing itself, and shows the caller's `refusal`.
 */
export function BuyStampDialog({ open, ...rest }: BuyStampDialogProps) {
  return open ? <BuyDialogBody {...rest} /> : null;
}
