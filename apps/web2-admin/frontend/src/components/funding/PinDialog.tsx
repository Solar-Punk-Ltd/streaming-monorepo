import { useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { AdminFundingNode } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { ApiError } from '../../http';
import { PasswordDialog } from './PasswordDialog';

/**
 * Confirming the wallet addresses the manager reports for new nodes and for nodes whose address changed. The brand
 * wallet sends only to a confirmed address, so a changed one shows the address it had and the one it has now.
 */
export function PinDialog({
  nodes,
  onDone,
  onCancel,
}: {
  nodes: readonly AdminFundingNode[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (password: string): Promise<'wrong-password' | void> => {
    setBusy(true);
    setError(null);
    try {
      await api.confirmFundingPins(
        password,
        nodes.map((node) => node.nodeId),
      );
      onDone();
    } catch (e: unknown) {
      setError(errorMessage(e, 'The addresses could not be confirmed.'));
      setBusy(false);
      if (e instanceof ApiError && e.code === 'invalid_credentials') return 'wrong-password';
    }
    return undefined;
  };

  return (
    <PasswordDialog
      title="Confirm wallet addresses"
      confirmText="Confirm addresses"
      busy={busy}
      error={error}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      <Typography variant="body2">
        The brand wallet sends only to addresses confirmed here. Check each one against its node before you confirm it.
      </Typography>
      <Stack spacing={1.5} component="ul" sx={{ m: 0, pl: 2.5 }}>
        {nodes.map((node) => (
          <Box component="li" key={node.nodeId}>
            <Typography variant="body2">
              {node.label} ({node.role}){node.pin === 'changed' ? ', changed' : ', new'}
            </Typography>
            {node.pin === 'changed' && node.pinnedAddress ? (
              <Typography variant="caption" component="div" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                was {node.pinnedAddress}
              </Typography>
            ) : null}
            <Typography variant="caption" component="div" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {node.pin === 'changed' ? 'now ' : ''}
              {node.walletAddress}
            </Typography>
          </Box>
        ))}
      </Stack>
    </PasswordDialog>
  );
}
