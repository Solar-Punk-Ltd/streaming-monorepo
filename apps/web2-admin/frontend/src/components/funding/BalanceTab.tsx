import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { FundingTransferItem, FundingView } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { useSnackbar } from '../Snackbar';
import { formatUnits } from './amounts';
import { allNodes, checkSend, nodeGroups, TOKENS, unconfirmedNodes, type Drafts, type SendCheck } from './balance';
import { NodeTable } from './NodeTable';
import { PinDialog } from './PinDialog';
import { SendDialog } from './SendDialog';
import { TransferProgress } from './TransferProgress';
import { WalletCard } from './WalletCard';

/** Said while a send is still on its way, so a second one does not race the first for the wallet's nonces. */
const WAIT_FOR_TRANSFERS = 'Wait for the transfers above to finish.';

/** The send the page follows: one it made, or the one the view says is still open. */
interface FollowedSend {
  bulkId: string;
  /** What the send answered, or none for an open send the page found in the view, which it then reads at once. */
  items: readonly FundingTransferItem[];
  /** Whether its transfers no longer hold Send back. */
  settled: boolean;
}

/**
 * The send to follow once the view is read. The view's open send, `openBulkId`, is followed when the page follows
 * none, or one that no longer holds Send back, so a reload or another tab finds it again. A send the page follows that
 * still holds Send back is kept: the view may have been read before it was made.
 */
function follow(current: FollowedSend | null, openBulkId: string | null): FollowedSend | null {
  if (!openBulkId || openBulkId === current?.bulkId) return current;
  if (current && !current.settled) return current;
  return { bulkId: openBulkId, items: [], settled: false };
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

/** The totals against the wallet's balances, why Send cannot send yet, and Send. */
function SendBar({
  check,
  wallet,
  blocked,
  onSend,
}: {
  check: SendCheck;
  wallet: FundingView['wallet'];
  blocked: string | null;
  onSend: () => void;
}) {
  // Said once each: two nodes that share a label would otherwise give the same sentence twice.
  const problems = [...new Set(blocked ? [...check.problems, blocked] : check.problems)];
  const total = (kind: 'xdai' | 'xbzz') => {
    const balance = kind === 'xdai' ? wallet?.xdaiWei : wallet?.xbzzPlur;
    const of = balance ? ` of ${formatUnits(balance, TOKENS[kind].decimals)}` : '';
    return (
      <Box component="span" sx={check.over[kind] ? { color: 'error.main' } : undefined}>
        {formatUnits(check.totals[kind], TOKENS[kind].decimals)}
        {of} {TOKENS[kind].name}
      </Box>
    );
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="body2">
          To send: {total('xdai')} · {total('xbzz')}
        </Typography>
        {problems.map((problem) => (
          <Typography key={problem} variant="caption" sx={{ color: 'text.secondary' }}>
            {problem}
          </Typography>
        ))}
        <Stack direction="row">
          <Button variant="contained" disabled={problems.length > 0} onClick={onSend}>
            Send
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

/**
 * The Balance tab: the brand wallet, then every node grouped by stage with the catalogue node on top, each with its
 * balances and whether its address is confirmed. Enter amounts beside the nodes' balances, which ticks them, and send
 * from the brand wallet; the password is asked first, and each transfer is followed until it comes to its end. Send
 * waits while a send is on its way, the one made here or the one the view says is open, which the page follows after a
 * reload too.
 */
export function BalanceTab() {
  const snackbar = useSnackbar();
  const [view, setView] = useState<FundingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Drafts>({});
  const [pinning, setPinning] = useState(false);
  const [sending, setSending] = useState(false);
  const [followed, setFollowed] = useState<FollowedSend | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .fetchFunding()
      .then((next) => {
        setView(next);
        setNow(Date.now());
        setFollowed((current) => follow(current, next.openBulkId));
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load the funding page')));
  }, []);

  useEffect(load, [load]);

  const groups = useMemo(() => (view ? nodeGroups(view) : []), [view]);
  const unconfirmed = useMemo(() => (view ? unconfirmedNodes(view) : []), [view]);
  const labels = useMemo(() => new Map(view ? allNodes(view).map((node) => [node.nodeId, node.label]) : []), [view]);
  const check = useMemo(() => (view ? checkSend(view, drafts) : null), [view, drafts]);

  const onSettled = useCallback(() => {
    setFollowed((current) => current && { ...current, settled: true });
    load();
  }, [load]);

  const unconfirmedCount = unconfirmed.length;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" sx={{ flexGrow: 1, color: 'text.secondary' }}>
          {view?.observedAt ? `Balances as the manager read them ${formatAgo(view.observedAt, now)}.` : ' '}
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

      {view?.configured ? (
        <>
          {view.managerError ? <Alert severity="warning">The manager did not answer: {view.managerError}</Alert> : null}
          <WalletCard wallet={view.wallet} />
          {followed ? (
            <TransferProgress
              key={followed.bulkId}
              bulkId={followed.bulkId}
              initial={followed.items}
              labels={labels}
              onSettled={onSettled}
              onDismiss={() => setFollowed(null)}
            />
          ) : null}
          {unconfirmedCount > 0 ? (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={() => setPinning(true)}>
                  Confirm addresses
                </Button>
              }
            >
              {unconfirmedCount === 1
                ? 'One node has a wallet address to confirm before the brand wallet sends to it.'
                : `${unconfirmedCount} nodes have wallet addresses to confirm before the brand wallet sends to them.`}
            </Alert>
          ) : null}
          {groups.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                The manager reports no nodes yet.
              </Typography>
            </Paper>
          ) : null}
          {groups.map((group) => (
            <NodeTable
              key={group.key}
              group={group}
              drafts={drafts}
              onChange={(nodeId, draft) => setDrafts((prev) => ({ ...prev, [nodeId]: draft }))}
            />
          ))}
          {check ? (
            <SendBar
              check={check}
              wallet={view.wallet}
              blocked={followed && !followed.settled ? WAIT_FOR_TRANSFERS : null}
              onSend={() => setSending(true)}
            />
          ) : null}
        </>
      ) : null}

      {pinning ? (
        <PinDialog
          nodes={unconfirmed}
          onDone={() => {
            setPinning(false);
            snackbar.success('Addresses confirmed.');
            load();
          }}
          onCancel={() => setPinning(false)}
        />
      ) : null}

      {sending && check ? (
        <SendDialog
          check={check}
          onSent={(answer) => {
            setSending(false);
            setDrafts({});
            setFollowed({ bulkId: answer.bulkId, items: answer.items, settled: false });
          }}
          onCancel={() => setSending(false)}
        />
      ) : null}
    </Stack>
  );
}
