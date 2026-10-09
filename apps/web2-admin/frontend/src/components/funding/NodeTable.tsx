import type { ReactNode } from 'react';
import {
  Box,
  Checkbox,
  Chip,
  InputAdornment,
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
import { acceptsAmountTyping, formatShort, formatUnits, readAmount } from './amounts';
import {
  NO_DRAFT,
  nodeCaption,
  nodeName,
  TOKENS,
  type Drafts,
  type NodeDraft,
  type NodeFocus,
  type NodeGroup,
} from './balance';

const KINDS: readonly FundingTransferKind[] = ['xdai', 'xbzz'];

/**
 * The tick column's width, set on a plain header cell. A table of fixed column widths takes them from its header, and
 * a small table's checkbox cell is 28 pixels, padding included, which the checkbox would stand out of.
 */
const CHECKBOX_WIDTH = 56;

/** The height of one token's line in the Balance, Send and After columns, the amount field's, so the three line up. */
const LINE_HEIGHT = 32;

const DIGITS = /^\d+$/;

function Line({ children, end = false }: { children: ReactNode; end?: boolean }) {
  return (
    <Box
      sx={{
        height: LINE_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: end ? 'flex-end' : 'flex-start',
      }}
    >
      {children}
    </Box>
  );
}

/** Whether the brand wallet may send to the node's address, as one chip; a changed one names the old one on hover. */
function PinChip({ node }: { node: AdminFundingNode }) {
  if (node.pin === 'pinned') return <Chip size="small" variant="outlined" color="success" label="Confirmed" />;
  if (node.pin === 'new') return <Chip size="small" variant="outlined" color="warning" label="New address" />;
  return (
    <Chip
      size="small"
      variant="outlined"
      color="error"
      label="Address changed"
      title={node.pinnedAddress ? `It was ${node.pinnedAddress}` : undefined}
    />
  );
}

/**
 * A node in three lines: its name, which never wraps and has the whole label as its tooltip, then its stage and role,
 * then its wallet with a copy button and the state of its address. A read error comes under them. The Stamps tab's
 * rows show it too, under the batch the node pays for, and the Chequebooks tab's beside its chequebook.
 */
export function NodeCard({ node, group }: { node: AdminFundingNode; group: NodeGroup }) {
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      <Typography variant="body2" noWrap title={node.label}>
        {nodeName(node, group)}
      </Typography>
      <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>
        {nodeCaption(node, group)}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {node.walletAddress ? (
          <>
            <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
              {shortHex(node.walletAddress)}
            </Typography>
            <CopyButton value={node.walletAddress} label="Wallet address" />
          </>
        ) : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Wallet not read
          </Typography>
        )}
        <PinChip node={node} />
      </Stack>
      {node.readError ? (
        <Typography variant="caption" sx={{ color: 'error.main' }}>
          {node.readError}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * One balance to three decimals, its token after it, and the exact amount as its tooltip. The Chequebooks tab shows
 * each node's wallet with it too.
 */
export function BalanceLine({ value, kind }: { value: string | null; kind: FundingTransferKind }) {
  const { name, decimals } = TOKENS[kind];
  return (
    <Typography
      variant="body2"
      noWrap
      title={value === null ? undefined : `${formatUnits(value, decimals)} ${name}`}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {formatShort(value, decimals)} {name}
    </Typography>
  );
}

/**
 * One token's amount to send, its token at the end. A character a number cannot hold is refused as it is typed or
 * pasted, and the field keeps what it had. A problem outlines it in red and is its tooltip, and the bar under the
 * tables says it too, so no line under the box changes the row's height.
 */
function SendField({
  kind,
  node,
  value,
  disabled,
  focused,
  onType,
}: {
  kind: FundingTransferKind;
  node: AdminFundingNode;
  value: string;
  disabled: boolean;
  /** Whether the field takes the focus when it is drawn, which scrolls it into view. */
  focused: boolean;
  onType: (value: string) => void;
}) {
  const { name, decimals } = TOKENS[kind];
  const read = readAmount(value, decimals);
  return (
    <TextField
      size="small"
      placeholder="0"
      value={value}
      disabled={disabled}
      autoFocus={focused}
      onChange={(e) => {
        if (acceptsAmountTyping(e.target.value)) onType(e.target.value);
      }}
      error={read.kind === 'invalid'}
      title={read.kind === 'invalid' ? read.problem : undefined}
      slotProps={{
        htmlInput: { inputMode: 'decimal', 'aria-label': `${name} to send to ${node.label}` },
        input: { endAdornment: <InputAdornment position="end">{name}</InputAdornment> },
      }}
      sx={{
        width: '100%',
        '& .MuiInputBase-root': { height: LINE_HEIGHT },
        '& .MuiInputBase-input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      }}
    />
  );
}

/** What the node will hold once the amount arrives, or a dash while there is no amount to add or no balance read. */
function AfterLine({ balance, typed, kind }: { balance: string | null; typed: string; kind: FundingTransferKind }) {
  const { name, decimals } = TOKENS[kind];
  const read = readAmount(typed, decimals);
  if (read.kind !== 'ok' || balance === null || !DIGITS.test(balance)) {
    return (
      <Typography variant="body2" sx={{ color: 'text.disabled' }}>
        —
      </Typography>
    );
  }
  const after = (BigInt(balance) + BigInt(read.value)).toString();
  return (
    <Typography
      variant="body2"
      noWrap
      title={`${formatUnits(after, decimals)} ${name}`}
      sx={{ color: 'success.main', fontVariantNumeric: 'tabular-nums' }}
    >
      {formatShort(after, decimals)} {name}
    </Typography>
  );
}

/**
 * One group of nodes, the catalogue node or one stage's, as a ledger line per token: the node's balance, the amount to
 * send it and what it holds after, so each amount stands beside the balance it tops up. The amount fields are always
 * there: typing an amount ticks the node, clearing both unticks it, and unticking clears them, so a row never changes
 * its size. Each node's card names it, its stage and role, and its wallet, with its address's state on that line.
 */
export function NodeTable({
  group,
  drafts,
  focus = null,
  onChange,
}: {
  group: NodeGroup;
  drafts: Drafts;
  /** The amount field that takes the focus when the table is drawn: the first one Fund all of another tab entered. */
  focus?: NodeFocus | null;
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
          <Table size="small" aria-label={`Nodes of ${group.title}`} sx={{ tableLayout: 'fixed', minWidth: 760 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: CHECKBOX_WIDTH }} />
                <TableCell>Node</TableCell>
                <TableCell align="right" sx={{ width: 140 }}>
                  Balance
                </TableCell>
                <TableCell sx={{ width: 200 }}>Send</TableCell>
                <TableCell align="right" sx={{ width: 140 }}>
                  After
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {group.nodes.map((node) => {
                const draft = drafts[node.nodeId] ?? NO_DRAFT;
                const save = (next: NodeDraft) => onChange(node.nodeId, next);
                const type = (kind: FundingTransferKind, value: string) => {
                  const next = { ...draft, [kind]: value };
                  save({ ...next, ticked: next.xdai !== '' || next.xbzz !== '' });
                };
                const balances: Record<FundingTransferKind, string | null> = {
                  xdai: node.xdaiWei,
                  xbzz: node.xbzzPlur,
                };
                const noWallet = node.walletAddress === null;
                return (
                  <TableRow key={node.nodeId} selected={draft.ticked}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={draft.ticked}
                        disabled={noWallet}
                        onChange={(e) => save(e.target.checked ? { ...draft, ticked: true } : NO_DRAFT)}
                        slotProps={{ input: { 'aria-label': `Send to ${node.label}` } }}
                      />
                    </TableCell>
                    <TableCell>
                      <NodeCard node={node} group={group} />
                    </TableCell>
                    <TableCell align="right">
                      <Stack spacing={0.5}>
                        {KINDS.map((kind) => (
                          <Line key={kind} end>
                            <BalanceLine value={balances[kind]} kind={kind} />
                          </Line>
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        {KINDS.map((kind) => (
                          <Line key={kind}>
                            <SendField
                              kind={kind}
                              node={node}
                              value={draft[kind]}
                              disabled={noWallet}
                              focused={focus !== null && kind === focus.kind && node.nodeId === focus.nodeId}
                              onType={(value) => type(kind, value)}
                            />
                          </Line>
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Stack spacing={0.5}>
                        {KINDS.map((kind) => (
                          <Line key={kind} end>
                            <AfterLine balance={balances[kind]} typed={draft[kind]} kind={kind} />
                          </Line>
                        ))}
                      </Stack>
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
