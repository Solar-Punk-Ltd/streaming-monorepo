import {
  Checkbox,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import type { AdminFundingNode, FundingTransferKind } from '@streaming-monorepo/web2-admin-common';

import { shortHex } from '../../format';
import { CopyButton } from '../CopyButton';
import { formatUnits, readAmount } from './amounts';
import { TOKENS, type Drafts, type NodeDraft, type NodeGroup } from './balance';

const NO_DRAFT: NodeDraft = { ticked: false, xdai: '', xbzz: '' };

/** Whether the brand wallet may send to the node's address: confirmed, new, or changed since it was confirmed. */
function PinState({ node }: { node: AdminFundingNode }) {
  if (node.pin === 'pinned') return <Chip size="small" variant="outlined" color="success" label="Confirmed" />;
  if (node.pin === 'new') return <Chip size="small" variant="outlined" color="warning" label="New address" />;
  return (
    <Stack spacing={0.25} sx={{ alignItems: 'flex-start' }}>
      <Chip size="small" variant="outlined" color="error" label="Address changed" />
      {node.pinnedAddress ? (
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
          was {shortHex(node.pinnedAddress)}
        </Typography>
      ) : null}
    </Stack>
  );
}

function AmountField({
  kind,
  node,
  value,
  onChange,
}: {
  kind: FundingTransferKind;
  node: AdminFundingNode;
  value: string;
  onChange: (value: string) => void;
}) {
  const read = readAmount(value, TOKENS[kind].decimals);
  return (
    <TextField
      size="small"
      label={TOKENS[kind].name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={read.kind === 'invalid'}
      helperText={read.kind === 'invalid' ? read.problem : ' '}
      slotProps={{ htmlInput: { inputMode: 'decimal', 'aria-label': `${TOKENS[kind].name} to send to ${node.label}` } }}
      sx={{ width: 150 }}
    />
  );
}

function balanceOf(value: string | null, decimals: number): string {
  return value === null ? '—' : formatUnits(value, decimals);
}

/**
 * One group of nodes, the catalogue node or one stage's: each with its role, wallet address and balances, any read
 * error, and whether its address is confirmed. Ticking a node opens an xDAI and an xBZZ amount to send it.
 */
export function NodeTable({
  group,
  drafts,
  onChange,
}: {
  group: NodeGroup;
  drafts: Drafts;
  onChange: (nodeId: string, draft: NodeDraft) => void;
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle1" component="h3">
        {group.title}
      </Typography>
      {group.nodes.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          The manager reports no node for this stage.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label={`Nodes of ${group.title}`}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Node</TableCell>
                <TableCell>Wallet</TableCell>
                <TableCell align="right">xDAI</TableCell>
                <TableCell align="right">xBZZ</TableCell>
                <TableCell>Address</TableCell>
                <TableCell>Send</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {group.nodes.map((node) => {
                const draft = drafts[node.nodeId] ?? NO_DRAFT;
                const set = (patch: Partial<NodeDraft>) => onChange(node.nodeId, { ...draft, ...patch });
                return (
                  <TableRow key={node.nodeId}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={draft.ticked}
                        disabled={node.walletAddress === null}
                        onChange={(e) => set({ ticked: e.target.checked })}
                        slotProps={{ input: { 'aria-label': `Send to ${node.label}` } }}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.25}>
                        <Typography variant="body2">{node.label}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {node.role}
                        </Typography>
                        {node.readError ? (
                          <Typography variant="caption" sx={{ color: 'error.main' }}>
                            {node.readError}
                          </Typography>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {node.walletAddress ? (
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                            {shortHex(node.walletAddress)}
                          </Typography>
                          <CopyButton value={node.walletAddress} label="Wallet address" />
                        </Stack>
                      ) : (
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                          Not read
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">{balanceOf(node.xdaiWei, TOKENS.xdai.decimals)}</TableCell>
                    <TableCell align="right">{balanceOf(node.xbzzPlur, TOKENS.xbzz.decimals)}</TableCell>
                    <TableCell>
                      <PinState node={node} />
                    </TableCell>
                    <TableCell>
                      {draft.ticked ? (
                        <Stack direction="row" spacing={1}>
                          <AmountField kind="xdai" node={node} value={draft.xdai} onChange={(xdai) => set({ xdai })} />
                          <AmountField kind="xbzz" node={node} value={draft.xbzz} onChange={(xbzz) => set({ xbzz })} />
                        </Stack>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
