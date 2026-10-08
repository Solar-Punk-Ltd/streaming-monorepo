import { useCallback, useMemo, useState } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import type { FundingTransferItem, FundingView } from '@streaming-monorepo/web2-admin-common';

import { useSnackbar } from '../Snackbar';
import { formatUnits } from './amounts';
import {
  allNodes,
  checkSend,
  fundFocus,
  nodeGroups,
  TOKENS,
  unconfirmedNodes,
  type Drafts,
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
 * `initialDrafts` is what the tab opens with, read once when it mounts: what a Fund link of the Stamps or the
 * Chequebooks tab enters for the node it names. Its xBZZ field then takes the focus, or its xDAI field when the link
 * entered no xBZZ, the gas being all the node lacks.
 */
export function BalanceTab({ initialDrafts }: { initialDrafts?: Drafts }) {
  const snackbar = useSnackbar();
  const [drafts, setDrafts] = useState<Drafts>(initialDrafts ?? {});
  const [focus] = useState(() => fundFocus(initialDrafts));
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
          {groups.map((group) => (
            <NodeTable
              key={group.key}
              group={group}
              drafts={drafts}
              focus={focus}
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
