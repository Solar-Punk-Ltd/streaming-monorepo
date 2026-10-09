import { useCallback, useState } from 'react';
import { Stack, Tab, Tabs, Typography } from '@mui/material';

import { BalanceTab } from '../components/funding/BalanceTab';
import { fundDrafts, fundFocus, type Drafts, type NodeFocus } from '../components/funding/balance';
import { FIRST_CHEQUEBOOK_SELECTION, type ChequebookSelection } from '../components/funding/chequebooks';
import { ChequebooksTab } from '../components/funding/ChequebooksTab';
import { FIRST_STAMP_SELECTION, type StampSelection } from '../components/funding/stamps';
import { StampsTab } from '../components/funding/StampsTab';

type FundingTab = 'balance' | 'stamps' | 'chequebooks';

/**
 * Funding: keeping the brand's stages alive from the admin. The Balance tab funds the node wallets from the brand
 * wallet, the Stamps tab tops up and dilutes the nodes' batches, and the Chequebooks tab brings the nodes' chequebooks
 * to a target, each node paying from its own wallet. Every operation goes through the manager.
 *
 * The tabs are drawn one at a time, so what each holds lives here, not in the tab: the Balance tab's ticks and amounts,
 * the Stamps tab's operation, days, steps and ticks, and the Chequebooks tab's target and ticks. Switching tabs keeps
 * them; a reload or leaving the page does not. Each tab still reads the view afresh when it is shown, and clears its own
 * ticks, with the Balance tab's amounts, once what they ask for is sent.
 *
 * A Fund link of the Stamps or the Chequebooks tab opens the Balance tab with what the node lacks entered for it, or
 * the node ticked when all it lacks is the xDAI for the gas, into what that tab already holds; the field it entered
 * takes the focus. A tab picked by hand takes no focus.
 */
export function FundingPage() {
  const [tab, setTab] = useState<FundingTab>('balance');
  const [drafts, setDrafts] = useState<Drafts>({});
  const [focus, setFocus] = useState<NodeFocus | null>(null);
  const [stamps, setStamps] = useState<StampSelection>(FIRST_STAMP_SELECTION);
  const [chequebooks, setChequebooks] = useState<ChequebookSelection>(FIRST_CHEQUEBOOK_SELECTION);

  const fund = useCallback((nodeId: string, xbzzPlur: string | null) => {
    setDrafts((current) => fundDrafts(current, nodeId, xbzzPlur));
    setFocus(fundFocus(nodeId, xbzzPlur));
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
          setFocus(null);
          setTab(next);
        }}
        aria-label="Funding"
      >
        <Tab value="balance" label="Balance" />
        <Tab value="stamps" label="Stamps" />
        <Tab value="chequebooks" label="Chequebooks" />
      </Tabs>
      {tab === 'balance' ? <BalanceTab drafts={drafts} onDrafts={setDrafts} focus={focus} /> : null}
      {tab === 'stamps' ? <StampsTab selection={stamps} onSelection={setStamps} onFund={fund} /> : null}
      {tab === 'chequebooks' ? (
        <ChequebooksTab selection={chequebooks} onSelection={setChequebooks} onFund={fund} />
      ) : null}
    </Stack>
  );
}
