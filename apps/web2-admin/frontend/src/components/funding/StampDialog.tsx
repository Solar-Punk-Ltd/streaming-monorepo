import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import {
  XBZZ_DECIMALS,
  type FundingStampOperationKind,
  type FundingStampOperationsAnswer,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { formatTimeLeft, shortHex } from '../../format';
import { formatUnits } from './amounts';
import { batchCount, dayCount, type StampCheck } from './stamps';

/** Said under the top-ups to confirm: who pays for what, and that the time they buy is at today's price. */
export const TOP_UP_NOTE =
  "Each node pays for its own batches from its wallet, in xBZZ, and the gas in xDAI. The time left after is at today's price.";

/** Said under the dilutions to confirm: what they cost, and that they cannot be undone. */
export const DILUTE_NOTE =
  'A dilution costs no xBZZ: each node pays only the gas, in xDAI. A batch cannot be made shallower again.';

/** Said in place of the list while the view is read again, as the dialog opens. */
export const READING_AGAIN = "Reading the batches and today's price of postage again…";

/** Said when the view could not be read again as the dialog opened, with why: the dialog then asks for nothing. */
export function readAgainFailed(error: string): string {
  return `The batches could not be read again, so nothing is asked for: ${error}`;
}

/**
 * What a stamp operation asks for, batch by batch, with what each costs, before anything is asked of a node. The tab
 * reads the view again as it opens it, and the dialog lists what it asks for, and what each costs, from that reading
 * alone: while the reading is on its way, or when it failed, the dialog lists and asks for nothing. A stamp operation
 * pays from the nodes' own wallets and moves nothing out of the brand wallet, so there is no password, only this
 * dialog. A refusal is said in it, and `onFailed` lets the tab read the view again, which finds a stamp bulk that went
 * out even though its answer did not come back.
 */
export function StampDialog({
  operation,
  check,
  reading,
  readError,
  onSent,
  onFailed,
  onCancel,
}: {
  operation: FundingStampOperationKind;
  check: StampCheck;
  /** Whether the view is being read again: `check` is worked out from the view as it was before. */
  reading: boolean;
  /** Why the view could not be read again, or null. */
  readError: string | null;
  onSent: (answer: FundingStampOperationsAnswer) => void;
  onFailed: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const topUp = operation === 'topup';
  /** Whether `check` comes from the view read again, so the dialog lists it and may ask for it. */
  const fresh = !reading && readError === null;

  const confirm = async () => {
    if (!fresh) return;
    // The view can change while the dialog is open, so what the operation may ask for is checked again now.
    const items = check.lines.flatMap((line) => (line.request ? [line.request] : []));
    const problem = check.problems[0] ?? (items.length === check.lines.length ? null : 'Check the days first.');
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSent(await api.sendFundingStampOperations(items));
    } catch (e: unknown) {
      setError(errorMessage(e, 'The stamp operations could not be sent.'));
      setBusy(false);
      onFailed();
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{`${topUp ? 'Top up' : 'Dilute'} ${batchCount(check.lines.length)}?`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {reading ? (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} aria-label="Reading the batches again" />
              <Typography variant="body2">{READING_AGAIN}</Typography>
            </Stack>
          ) : null}
          {!reading && readError !== null ? <Alert severity="error">{readAgainFailed(readError)}</Alert> : null}
          {fresh ? (
            <Table size="small" aria-label={topUp ? 'Top-ups to ask for' : 'Dilutions to ask for'}>
              <TableBody>
                {check.lines.map((line) => (
                  <TableRow key={line.batch.batchId}>
                    <TableCell>
                      <Stack spacing={0.25}>
                        <Typography variant="body2">{line.node.label}</Typography>
                        <Typography
                          variant="caption"
                          title={line.batch.batchId}
                          sx={{ fontFamily: 'monospace', color: 'text.secondary' }}
                        >
                          {shortHex(line.batch.batchId)}
                        </Typography>
                      </Stack>
                    </TableCell>
                    {topUp ? (
                      <>
                        <TableCell align="right">
                          {line.request?.kind === 'topup' ? dayCount(line.request.days) : '—'}
                        </TableCell>
                        <TableCell align="right">
                          {line.costPlur === null ? '—' : `${formatUnits(line.costPlur, XBZZ_DECIMALS)} xBZZ`}
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell align="right">
                          Depth {line.batch.depth} to {line.newDepth}
                        </TableCell>
                        <TableCell align="right">{formatTimeLeft(line.ttlAfterSeconds)} left after</TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {fresh && topUp && check.totalCostPlur !== null ? (
            <Typography variant="body2">In all: {formatUnits(check.totalCostPlur, XBZZ_DECIMALS)} xBZZ.</Typography>
          ) : null}
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {topUp ? TOP_UP_NOTE : DILUTE_NOTE}
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !fresh}
          startIcon={busy ? <CircularProgress size={16} /> : null}
          onClick={() => void confirm()}
        >
          {topUp ? 'Top up' : 'Dilute'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
