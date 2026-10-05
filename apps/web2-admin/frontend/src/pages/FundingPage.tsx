import { useState } from 'react';
import { Paper, Stack, Tab, Tabs, Typography } from '@mui/material';

import { BalanceTab } from '../components/funding/BalanceTab';

type FundingTab = 'balance' | 'stamps' | 'chequebooks';

/** What the two tabs that come next will do, said in their place until they do it. */
export const COMING_NEXT: Readonly<Record<Exclude<FundingTab, 'balance'>, string>> = {
  stamps:
    "Coming next: topping up the catalogue batch and every stage's batches from here, each node paying from its own wallet.",
  chequebooks:
    "Coming next: filling the chequebooks of every stage's nodes from here, each node depositing from its own wallet.",
};

/**
 * Funding: keeping the brand's stages alive from the admin. The Balance tab funds the node wallets from the brand
 * wallet; topping up the batches and filling the chequebooks come next. Every operation goes through the manager.
 */
export function FundingPage() {
  const [tab, setTab] = useState<FundingTab>('balance');
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        Funding
      </Typography>
      <Tabs value={tab} onChange={(_event, next: FundingTab) => setTab(next)} aria-label="Funding">
        <Tab value="balance" label="Balance" />
        <Tab value="stamps" label="Stamps" />
        <Tab value="chequebooks" label="Chequebooks" />
      </Tabs>
      {tab === 'balance' ? (
        <BalanceTab />
      ) : (
        <Paper variant="outlined" sx={{ p: 4 }}>
          <Typography variant="body2">{COMING_NEXT[tab]}</Typography>
        </Paper>
      )}
    </Stack>
  );
}
