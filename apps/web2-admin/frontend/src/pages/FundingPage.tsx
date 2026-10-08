import { useCallback, useState } from 'react';
import { Paper, Stack, Tab, Tabs, Typography } from '@mui/material';

import { BalanceTab } from '../components/funding/BalanceTab';
import { fundDrafts, type Drafts } from '../components/funding/balance';
import { StampsTab } from '../components/funding/StampsTab';

type FundingTab = 'balance' | 'stamps' | 'chequebooks';

/** What the tab that comes next will do, said in its place until it does it. */
export const COMING_NEXT: Readonly<Record<'chequebooks', string>> = {
  chequebooks:
    "Coming next: filling the chequebooks of every stage's nodes from here, each node depositing from its own wallet.",
};

/**
 * Funding: keeping the brand's stages alive from the admin. The Balance tab funds the node wallets from the brand
 * wallet, and the Stamps tab tops up and dilutes the nodes' batches, each node paying from its own wallet; filling the
 * chequebooks comes next. Every operation goes through the manager.
 *
 * A Stamps tab's Fund link opens the Balance tab with what the node lacks entered for it. The tabs are drawn one at a
 * time, so the Balance tab takes that once, as it mounts, and a tab picked by hand opens without it.
 */
export function FundingPage() {
  const [tab, setTab] = useState<FundingTab>('balance');
  const [prefill, setPrefill] = useState<Drafts | undefined>(undefined);

  const fund = useCallback((nodeId: string, xbzzPlur: string) => {
    setPrefill(fundDrafts(nodeId, xbzzPlur));
    setTab('balance');
  }, []);

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        Funding
      </Typography>
      <Tabs
        value={tab}
        onChange={(_event, next: FundingTab) => {
          setPrefill(undefined);
          setTab(next);
        }}
        aria-label="Funding"
      >
        <Tab value="balance" label="Balance" />
        <Tab value="stamps" label="Stamps" />
        <Tab value="chequebooks" label="Chequebooks" />
      </Tabs>
      {tab === 'balance' ? <BalanceTab initialDrafts={prefill} /> : null}
      {tab === 'stamps' ? <StampsTab onFund={fund} /> : null}
      {tab === 'chequebooks' ? (
        <Paper variant="outlined" sx={{ p: 4 }}>
          <Typography variant="body2">{COMING_NEXT.chequebooks}</Typography>
        </Paper>
      ) : null}
    </Stack>
  );
}
