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
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { XBZZ_DECIMALS, type FundingChequebookOperationsAnswer } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { formatUnits } from './amounts';
import {
  availableAfter,
  chequebookCount,
  moveText,
  NOTHING_TO_CHANGE_PROBLEM,
  type ChequebookCheck,
} from './chequebooks';

/** Said under the moves to confirm: who pays for what, and where a withdrawal goes. */
export const PAYS_NOTE =
  "Each node pays a deposit from its own wallet, in xBZZ, and the gas of either move in xDAI. A withdrawal goes into the node's own wallet.";

/**
 * Said under the moves to confirm: the API works each move out again from the balance it reads when the request comes
 * in, `chequebookMoveNow`, and never moves more than the dialog lists.
 */
export const WORKED_OUT_AGAIN_NOTE =
  'Each move is worked out again from the balance read when it is sent, and never moves more than listed here.';

/** Said under the moves to confirm: why a chequebook's balance lands near the target rather than on it. */
export const BUSY_NODE_NOTE =
  'A busy node keeps paying its peers out of its chequebook, so its balance lands near the target, not on it.';

/** Said in place of the list while the view is read again, as the dialog opens. */
export const READING_CHEQUEBOOKS_AGAIN = 'Reading the chequebooks and the wallets again…';

/** Said when the view could not be read again as the dialog opened, with why: the dialog then asks for nothing. */
export function readChequebooksAgainFailed(error: string): string {
  return `The chequebooks could not be read again, so nothing is asked for: ${error}`;
}

/** Said under the list of the ticked chequebooks at the target, for which nothing is asked. */
export function atTargetText(count: number): string {
  return count === 1
    ? '1 ticked chequebook is at the target already, so nothing is asked for it.'
    : `${count} ticked chequebooks are at the target already, so nothing is asked for them.`;
}

/** An amount of xBZZ, every digit of it. */
function exact(plur: string): string {
  return `${formatUnits(plur, XBZZ_DECIMALS)} xBZZ`;
}

/**
 * What Apply asks for, chequebook by chequebook: the node, the move, deposit or withdraw and every digit of its amount,
 * and the chequebook's available balance before and after, before anything is asked of a node. The tab reads the view
 * again as it opens it, and the dialog lists and asks for the moves from that reading alone: while the reading is on
 * its way, or when it failed, the dialog lists and asks for nothing. Each item names the available balance the reading
 * shows, from which, and the balance it reads when the request comes in, the API works the move out again, never more
 * than the dialog listed; the dialog says so, and the progress then shows what the API answered. A chequebook operation
 * pays from the nodes' own wallets and moves nothing out of the brand wallet, so there is no password, only this
 * dialog. A refusal is said in it, and `onFailed` lets the tab read the view again, which finds a bulk that went out
 * even though its answer did not come back.
 */
export function ChequebookDialog({
  check,
  reading,
  readError,
  onSent,
  onFailed,
  onCancel,
}: {
  check: ChequebookCheck;
  /** Whether the view is being read again: `check` is worked out from the view as it was before. */
  reading: boolean;
  /** Why the view could not be read again, or null. */
  readError: string | null;
  onSent: (answer: FundingChequebookOperationsAnswer) => void;
  onFailed: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Whether `check` comes from the view read again, so the dialog lists it and may ask for it. */
  const fresh = !reading && readError === null;
  const moving = check.lines.filter((line) => line.move !== null);
  const atTarget = check.lines.length - moving.length;
  const title =
    check.target.kind === 'ok'
      ? `Bring ${chequebookCount(moving.length)} to ${exact(check.target.plur)}?`
      : `Bring ${chequebookCount(moving.length)} to the target?`;

  const confirm = async () => {
    if (!fresh) return;
    // The view can change while the dialog is open, so what Apply may ask for is checked again now.
    const request = check.request;
    const problem = check.problems[0] ?? null;
    if (problem !== null || request === null) {
      setError(problem ?? NOTHING_TO_CHANGE_PROBLEM);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSent(await api.sendFundingChequebookOperations(request));
    } catch (e: unknown) {
      setError(errorMessage(e, 'The chequebook operations could not be sent.'));
      setBusy(false);
      onFailed();
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onCancel} maxWidth="md" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {reading ? (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} aria-label="Reading the chequebooks again" />
              <Typography variant="body2">{READING_CHEQUEBOOKS_AGAIN}</Typography>
            </Stack>
          ) : null}
          {!reading && readError !== null ? (
            <Alert severity="error">{readChequebooksAgainFailed(readError)}</Alert>
          ) : null}
          {fresh ? (
            <Table size="small" aria-label="Chequebook operations to ask for">
              <TableHead>
                <TableRow>
                  <TableCell>Node</TableCell>
                  <TableCell align="right">Move</TableCell>
                  <TableCell align="right">Available now</TableCell>
                  <TableCell align="right">Available after</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {moving.map((line) => (
                  <TableRow key={line.node.nodeId}>
                    <TableCell>{line.node.label}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {moveText(line.move)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {exact(line.availablePlur)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {exact(availableAfter(line))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {fresh && atTarget > 0 ? <Typography variant="body2">{atTargetText(atTarget)}</Typography> : null}
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {PAYS_NOTE}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {WORKED_OUT_AGAIN_NOTE}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {BUSY_NODE_NOTE}
            </Typography>
          </Stack>
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
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
