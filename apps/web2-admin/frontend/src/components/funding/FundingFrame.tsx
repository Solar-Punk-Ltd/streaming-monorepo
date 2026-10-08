import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { FundingView } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo } from '../../dateUtil';
import { errorMessage } from '../../errors';

/** The Funding page's view as one tab reads it: the view once read, why it could not be, and a way to read it again. */
export interface FundingRead {
  view: FundingView | null;
  error: string | null;
  /** When the view was last read, which "read 5 minutes ago" counts from. */
  now: number;
  load: () => void;
}

/**
 * Reads the Funding page's view when the tab mounts, and again on `load`. `onRead` hears each view in the render that
 * shows it, so a tab can follow the bulk the view says is open; it must keep its identity from render to render.
 */
export function useFundingView(onRead: (view: FundingView) => void): FundingRead {
  const [view, setView] = useState<FundingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    setError(null);
    api
      .fetchFunding()
      .then((next) => {
        setView(next);
        setNow(Date.now());
        onRead(next);
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load the funding page')));
  }, [onRead]);

  useEffect(load, [load]);

  return { view, error, now, load };
}

function NotSetUp() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
      <Typography variant="body1" gutterBottom>
        Not set up
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Funding needs the manager&apos;s address and token in the admin&apos;s env file, MANAGER_FUNDING_URL and
        MANAGER_FUNDING_TOKEN, and BRAND_WALLET_SECRET for the brand wallet.
      </Typography>
    </Paper>
  );
}

/**
 * What every tab shows above its own content: when the manager read the view, with Refresh; why it could not be read,
 * with Retry; the spinner while the first read is on its way; "Not set up" without the manager's settings; and what
 * the manager answered when it could not be read. They are siblings in the tab's own stack.
 */
export function FundingFrame({ read, readLine }: { read: FundingRead; readLine: (ago: string) => string }) {
  const { view, error, now, load } = read;
  return (
    <>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" sx={{ flexGrow: 1, color: 'text.secondary' }}>
          {view?.observedAt ? readLine(formatAgo(view.observedAt, now)) : ' '}
        </Typography>
        <Tooltip title="Refresh">
          <IconButton aria-label="refresh funding" onClick={load}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}

      {!view && !error ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress aria-label="Loading funding" />
        </Box>
      ) : null}

      {view && !view.configured ? <NotSetUp /> : null}

      {view?.configured && view.managerError ? (
        <Alert severity="warning">The manager did not answer: {view.managerError}</Alert>
      ) : null}
    </>
  );
}
