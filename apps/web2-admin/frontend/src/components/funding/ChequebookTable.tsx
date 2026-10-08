import {
  Checkbox,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import {
  chequebookUncashedPlur,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type ChequebookMove,
  type FundingChequebook,
} from '@streaming-monorepo/web2-admin-common';

import { formatShort, formatUnits } from './amounts';
import {
  moveText,
  NO_BREAK,
  NO_CHEQUEBOOK_IN_STAGE,
  whyNotMovable,
  type ChequebookCheck,
  type ChequebookGroup,
  type ChequebookLedger,
} from './chequebooks';
import { BalanceLine, NodeCard } from './NodeTable';

/**
 * The tick column's width, as the Balance and Stamps tabs have it: a table of fixed column widths takes them from its
 * header, and a small table's checkbox cell is 28 pixels, padding included, which the checkbox would stand out of.
 */
const CHECKBOX_WIDTH = 56;

/** A column after the node: its header, and its fixed width, wide enough for the header on one line. */
interface Column {
  label: string;
  width: number;
}

/**
 * The columns after the node, with fixed widths, so no row changes its size when it is ticked or a target is typed.
 * The chequebook's is as wide as its exact amounts need: every digit of a balance under 1000 xBZZ, on one line beside
 * its name. A move's amount is exact too, and wraps after its direction when it is long.
 */
const COLUMNS: readonly Column[] = [
  { label: 'Chequebook', width: 304 },
  { label: 'Wallet', width: 140 },
  { label: 'Move', width: 224 },
  { label: 'Wallet after', width: 160 },
];

/** The least width the node column keeps for the node's card. */
const NODE_MIN_WIDTH = 240;

/**
 * The table's least width: the tick, the node's least and the fixed columns, under the width of the console's page, so
 * the page never scrolls sideways; a narrower window scrolls the table rather than squeeze it.
 */
const TABLE_MIN_WIDTH = CHECKBOX_WIDTH + NODE_MIN_WIDTH + COLUMNS.reduce((sum, column) => sum + column.width, 0);

/** A header cell on one line, so the header row keeps one height. */
const HEADER = { whiteSpace: 'nowrap' } as const;

const NUMBERS = { fontVariantNumeric: 'tabular-nums' } as const;

/** An unticked row's empty cell, or a value that cannot be worked out. */
function Dash() {
  return (
    <Typography variant="body2" sx={{ color: 'text.disabled' }}>
      —
    </Typography>
  );
}

/** One of the chequebook's balances, named, with every digit of it: the one place the tab shows amounts exactly. */
function ExactLine({ label, value }: { label: string; value: string | null }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={NUMBERS}>
        {value === null ? '—' : `${formatUnits(value, XBZZ_DECIMALS)}${NO_BREAK}xBZZ`}
      </Typography>
    </Stack>
  );
}

/**
 * The chequebook's available balance, its total and the cheques its peers have not cashed yet, the total less the
 * available, each exact; or, when its node could not be read about it, why, in their place.
 */
function ChequebookLines({ chequebook }: { chequebook: FundingChequebook }) {
  if (chequebook.readError) {
    return (
      <Typography variant="body2" sx={{ color: 'error.main', textAlign: 'right' }}>
        {chequebook.readError}
      </Typography>
    );
  }
  return (
    <Stack spacing={0.25}>
      <ExactLine label="Available" value={chequebook.availablePlur} />
      <ExactLine label="Total" value={chequebook.totalPlur} />
      <ExactLine label="Uncashed" value={chequebookUncashedPlur(chequebook)} />
    </Stack>
  );
}

/** A ticked chequebook's move, every digit of its amount, as `moveText` says it. */
function MoveLine({ move }: { move: ChequebookMove | null }) {
  return (
    <Typography variant="body2" sx={{ ...NUMBERS, ...(move === null ? { color: 'text.secondary' } : {}) }}>
      {moveText(move)}
    </Typography>
  );
}

/**
 * What the node's wallet holds after its chequebook's move, to three decimals with the exact amount on hover; or, when
 * it cannot pay for its deposit, what it lacks in red, rounded up; and no xDAI for the gas in red. Either comes with a
 * Fund link to the Balance tab, with what the node lacks in xBZZ entered for it, or nothing entered when it lacks only
 * the xDAI.
 */
function WalletAfter({
  node,
  ledger,
  onFund,
}: {
  node: AdminFundingNode;
  ledger: ChequebookLedger | undefined;
  onFund: (nodeId: string, xbzzPlur: string | null) => void;
}) {
  if (!ledger) return <Dash />;
  const { afterPlur, shortPlur, fundPlur, noGas } = ledger;
  const short = shortPlur !== null && fundPlur !== null;
  let xbzz = <Dash />;
  if (short) {
    xbzz = (
      <Typography
        variant="body2"
        noWrap
        title={`${formatUnits(shortPlur, XBZZ_DECIMALS)} xBZZ short`}
        sx={{ ...NUMBERS, color: 'error.main' }}
      >
        Short {formatShort(fundPlur, XBZZ_DECIMALS)} xBZZ
      </Typography>
    );
  } else if (afterPlur !== null) {
    xbzz = <BalanceLine value={afterPlur} kind="xbzz" />;
  }
  return (
    <Stack spacing={0.25} sx={{ alignItems: 'flex-end' }}>
      {xbzz}
      {noGas ? (
        <Typography variant="body2" noWrap sx={{ color: 'error.main' }}>
          No xDAI for gas
        </Typography>
      ) : null}
      {short || noGas ? (
        <Link
          component="button"
          type="button"
          variant="body2"
          aria-label={`Fund ${node.label}`}
          onClick={() => onFund(node.nodeId, short ? fundPlur : null)}
        >
          Fund
        </Link>
      ) : null}
    </Stack>
  );
}

function ChequebookRow({
  node,
  group,
  ticked,
  check,
  onTick,
  onFund,
}: {
  node: AdminFundingNode;
  group: ChequebookGroup;
  ticked: boolean;
  check: ChequebookCheck | null;
  onTick: (nodeId: string) => void;
  onFund: (nodeId: string, xbzzPlur: string | null) => void;
}) {
  const why = whyNotMovable(node);
  const line = why === null && ticked ? check?.lineOf.get(node.nodeId) : undefined;
  return (
    <TableRow selected={why === null && ticked}>
      <TableCell padding="checkbox">
        {why === null ? (
          <Checkbox
            checked={ticked}
            onChange={() => onTick(node.nodeId)}
            slotProps={{ input: { 'aria-label': `Bring the chequebook of ${node.label} to the target` } }}
          />
        ) : null}
      </TableCell>
      <TableCell>
        <NodeCard node={node} group={group.nodes} />
      </TableCell>
      <TableCell align="right">
        {node.chequebook ? <ChequebookLines chequebook={node.chequebook} /> : <Dash />}
      </TableCell>
      <TableCell align="right">
        <Stack spacing={0.25} sx={{ alignItems: 'flex-end' }}>
          <BalanceLine value={node.xbzzPlur} kind="xbzz" />
          <BalanceLine value={node.xdaiWei} kind="xdai" />
        </Stack>
      </TableCell>
      {why === null ? (
        <>
          <TableCell align="right">{line ? <MoveLine move={line.move} /> : <Dash />}</TableCell>
          <TableCell align="right">
            {line?.move ? (
              <WalletAfter node={node} ledger={check?.ledgerOf.get(node.nodeId)} onFund={onFund} />
            ) : (
              <Dash />
            )}
          </TableCell>
        </>
      ) : (
        <TableCell colSpan={2}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {why}
          </Typography>
        </TableCell>
      )}
    </TableRow>
  );
}

/**
 * One stage's chequebooks, a row each: the tick box, the node's card, the chequebook's available balance, total and
 * uncashed cheques, every digit of each, the node's wallet, then, once the row is ticked and a target typed, the move
 * that brings the chequebook to the target and the node's xBZZ after it. A chequebook that cannot be ticked says why
 * in place of those. The columns keep fixed widths, and no row changes its size when it is ticked or a target typed.
 */
export function ChequebookTable({
  group,
  ticked,
  check,
  onTick,
  onFund,
}: {
  group: ChequebookGroup;
  ticked: ReadonlySet<string>;
  check: ChequebookCheck | null;
  onTick: (nodeId: string) => void;
  onFund: (nodeId: string, xbzzPlur: string | null) => void;
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle1" component="h3">
        {group.title}
      </Typography>
      {group.rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {NO_CHEQUEBOOK_IN_STAGE}
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table
            size="small"
            aria-label={`Chequebooks of ${group.title}`}
            sx={{ tableLayout: 'fixed', minWidth: TABLE_MIN_WIDTH }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ ...HEADER, width: CHECKBOX_WIDTH }} />
                <TableCell sx={HEADER}>Node</TableCell>
                {COLUMNS.map((column) => (
                  <TableCell key={column.label} align="right" sx={{ ...HEADER, width: column.width }}>
                    {column.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {group.rows.map((node, index) => (
                <ChequebookRow
                  key={`${index}:${node.nodeId}`}
                  node={node}
                  group={group}
                  ticked={ticked.has(node.nodeId)}
                  check={check}
                  onTick={onTick}
                  onFund={onFund}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
