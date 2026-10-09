import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import type { FundingTransferItem, FundingView } from '@streaming-monorepo/web2-admin-common';

import { useSnackbar } from '../Snackbar';
import { formatUnits } from './amounts';
import {
  allNodes,
  checkSend,
  hasDrafts,
  nodeGroups,
  TOKENS,
  unconfirmedNodes,
  type Drafts,
  type NodeFocus,
  type SendCheck,
} from './balance';
import { followBulk, type FollowedBulk } from './BulkProgress';
import { FundingFrame, useFundingView } from './FundingFrame';
import { NodeTable } from './NodeTable';
import { PinDialog } from './PinDialog';
import { SendDialog } from './SendDialog';
import { TransferProgress } from './TransferProgress';
import { WalletCard } from './WalletCard';

/** Said while a send is still on its way, so a second one does not race the first for the wallet's nonces. */
const WAIT_FOR_TRANSFERS = 'Wait for the transfers above to finish.';

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
 *
 * What is ticked and typed, `drafts`, is the Funding page's, so it stays while another tab is shown, and Fund all of
 * the Stamps or the Chequebooks tab enters what its nodes lack in it. A send clears it, and so does Clear all, above
 * the tables, which unticks every node and empties every amount typed; there is no Select all, since typing an amount
 * ticks its node. `focus` is the first field Fund all entered, which takes the focus as the tab is drawn.
 */
export function BalanceTab({
  drafts,
  onDrafts,
  focus,
}: {
  drafts: Drafts;
  onDrafts: Dispatch<SetStateAction<Drafts>>;
  focus: NodeFocus | null;
}) {
  const snackbar = useSnackbar();
  const [pinning, setPinning] = useState(false);
  const [sending, setSending] = useState(false);
  const [followed, setFollowed] = useState<FollowedBulk<FundingTransferItem> | null>(null);

  const onRead = useCallback((next: FundingView) => setFollowed((current) => followBulk(current, next.openBulkId)), []);
  const read = useFundingView(onRead);
  const { view, load } = read;

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
      <FundingFrame read={read} readLine={(ago) => `Balances as the manager read them ${ago}.`} />

      {view?.configured ? (
        <>
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
          {groups.length > 0 ? (
            <Stack direction="row">
              <Button size="small" disabled={!hasDrafts(view, drafts)} onClick={() => onDrafts({})}>
                Clear all
              </Button>
            </Stack>
          ) : null}
          {groups.map((group) => (
            <NodeTable
              key={group.key}
              group={group}
              drafts={drafts}
              focus={focus}
              onChange={(nodeId, draft) => onDrafts((prev) => ({ ...prev, [nodeId]: draft }))}
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
            onDrafts({});
            setFollowed({ bulkId: answer.bulkId, items: answer.items, settled: false });
          }}
          onCancel={() => setSending(false)}
        />
      ) : null}
    </Stack>
  );
}
