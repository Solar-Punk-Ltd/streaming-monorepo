import { Box, Paper, Stack, Typography } from '@mui/material';
import { XBZZ_DECIMALS, XDAI_DECIMALS, type FundingView } from '@streaming-monorepo/web2-admin-common';
import { QRCodeSVG } from 'qrcode.react';

import { CopyButton } from '../CopyButton';
import { formatUnits } from './amounts';

/** Said under the brand wallet: where its funds come from. Text alone: the page links to no wallet app. */
export const FUND_IT_TEXT =
  "Fund it from any wallet, for example with Swarm's Multichain app: xDAI pays the network fees, and xBZZ goes on to the nodes.";

/** Said in place of the wallet while the admin has none. */
export const NO_WALLET_TEXT =
  'There is no brand wallet yet. The admin creates one when it starts with BRAND_WALLET_SECRET set in its env file.';

/** The address as a QR code, for a wallet app to scan, dark on white whatever the theme so every scanner reads it. */
function AddressQr({ address }: { address: string }) {
  return (
    <Box
      role="img"
      aria-label="QR code of the wallet address"
      sx={{ p: 1, bgcolor: 'common.white', borderRadius: 1, lineHeight: 0, flexShrink: 0, alignSelf: 'flex-start' }}
    >
      <QRCodeSVG value={address} size={128} marginSize={1} />
    </Box>
  );
}

function balanceOf(value: string | null, decimals: number): string {
  return value === null ? '—' : formatUnits(value, decimals);
}

/** The brand wallet: its address to fund it at, with a copy button and a QR code, and what it holds. */
export function WalletCard({ wallet }: { wallet: FundingView['wallet'] }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" component="h2">
          Brand wallet
        </Typography>
        {wallet ? (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ alignItems: { sm: 'center' } }}>
            <AddressQr address={wallet.address} />
            <Stack spacing={1} sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {wallet.address}
                </Typography>
                <CopyButton value={wallet.address} label="Wallet address" />
              </Stack>
              <Typography variant="body1">{balanceOf(wallet.xdaiWei, XDAI_DECIMALS)} xDAI</Typography>
              <Typography variant="body1">{balanceOf(wallet.xbzzPlur, XBZZ_DECIMALS)} xBZZ</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {FUND_IT_TEXT}
              </Typography>
            </Stack>
          </Stack>
        ) : (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {NO_WALLET_TEXT}
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}
