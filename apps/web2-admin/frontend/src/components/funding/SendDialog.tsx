import { useState } from 'react';
import { Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import type { FundingTransfersAnswer } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { ApiError } from '../../http';
import { formatUnits } from './amounts';
import { TOKENS, type SendCheck } from './balance';
import { PasswordDialog } from './PasswordDialog';

/** Said in the send dialog: every transfer, of either kind, pays its network fee in xDAI from the brand wallet. */
export const FEE_NOTE = 'Every transfer also pays its network fee in xDAI from the brand wallet.';

/** What Send sends, item by item and in all, then the operator's password before anything leaves the brand wallet. */
export function SendDialog({
  check,
  onSent,
  onCancel,
}: {
  check: SendCheck;
  onSent: (answer: FundingTransfersAnswer) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (password: string): Promise<'wrong-password' | void> => {
    // The view can change while the dialog is open, so what Send may send is asked again now.
    const problem = check.problems[0];
    if (problem) {
      setError(problem);
      return undefined;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await api.sendFundingTransfers(
        password,
        check.lines.map(({ nodeId, kind, amount }) => ({ nodeId, kind, amount })),
      );
      onSent(answer);
    } catch (e: unknown) {
      setError(errorMessage(e, 'The transfers could not be sent.'));
      setBusy(false);
      if (e instanceof ApiError && e.code === 'invalid_credentials') return 'wrong-password';
    }
    return undefined;
  };

  const transfers = check.lines.length;
  return (
    <PasswordDialog
      title={`Send ${transfers} transfer${transfers === 1 ? '' : 's'} from the brand wallet?`}
      confirmText="Send"
      busy={busy}
      error={error}
      onConfirm={send}
      onCancel={onCancel}
    >
      <Table size="small" aria-label="Transfers to send">
        <TableBody>
          {check.lines.map((line) => (
            <TableRow key={`${line.nodeId}:${line.kind}`}>
              <TableCell>{line.label}</TableCell>
              <TableCell align="right">
                {formatUnits(line.amount, TOKENS[line.kind].decimals)} {TOKENS[line.kind].name}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="body2">
        In all: {formatUnits(check.totals.xdai, TOKENS.xdai.decimals)} xDAI and{' '}
        {formatUnits(check.totals.xbzz, TOKENS.xbzz.decimals)} xBZZ.
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {FEE_NOTE}
      </Typography>
    </PasswordDialog>
  );
}
