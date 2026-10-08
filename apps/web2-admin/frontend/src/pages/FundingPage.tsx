import { useCallback, useState } from 'react';
import { Stack, Tab, Tabs, Typography } from '@mui/material';

import { BalanceTab } from '../components/funding/BalanceTab';
import { fundDrafts, type Drafts } from '../components/funding/balance';
import { ChequebooksTab } from '../components/funding/ChequebooksTab';
import { StampsTab } from '../components/funding/StampsTab';

type FundingTab = 'balance' | 'stamps' | 'chequebooks';

/**
 * Funding: keeping the brand's stages alive from the admin. The Balance tab funds the node wallets from the brand
 * wallet, the Stamps tab tops up and dilutes the nodes' batches, and the Chequebooks tab brings the nodes' chequebooks
 * to a target, each node paying from its own wallet. Every operation goes through the manager.
 *
 * A Fund link of the Stamps or the Chequebooks tab opens the Balance tab with what the node lacks entered for it, or
 * the node ticked with nothing entered when all it lacks is the xDAI for the gas. The tabs are drawn one at a time, so
 * the Balance tab takes that once, as it mounts, and a tab picked by hand opens without it.
 */
export function FundingPage() {
  const [tab, setTab] = useState<FundingTab>('balance');
  const [prefill, setPrefill] = useState<Drafts | undefined>(undefined);

  const fund = useCallback((nodeId: string, xbzzPlur: string | null) => {
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
      {tab === 'chequebooks' ? <ChequebooksTab onFund={fund} /> : null}
    </Stack>
  );
}
