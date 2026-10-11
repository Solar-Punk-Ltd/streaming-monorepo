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
  Typography,
} from '@mui/material';
import {
  STAMP_EXPIRY_WARNING_SECONDS,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type FundingBatch,
  type FundingStampOperationKind,
} from '@streaming-monorepo/web2-admin-common';

import { formatPercent, formatTimeLeft, shortHex } from '../../format';
import { CopyButton } from '../CopyButton';
import { formatShort, formatUnits } from './amounts';
import { NodeCard } from './NodeTable';
import {
  tickableBatches,
  whyNoTickBox,
  type BatchGroup,
  type BatchRow,
  type NodeLedger,
  type StampCheck,
  type StampLine,
} from './stamps';
import { CHECKBOX_WIDTH, GroupTitle } from './Ticks';
import { monoFont } from '../../theme/createAdminTheme';

/** A column after the batch: its header, and its fixed width, wide enough for the header on one line. */
interface Column {
  label: string;
  width: number;
}

/** The batch's own readings, in every row whichever the operation. */
const READING_COLUMNS: readonly Column[] = [
  { label: 'Depth', width: 80 },
  { label: 'Time left', width: 112 },
  { label: 'Fill', width: 64 },
];

/** The columns a ticked row fills in, for each operation, with fixed widths, so no row changes its size. */
const AFTER_COLUMNS: Readonly<Record<FundingStampOperationKind, readonly Column[]>> = {
  topup: [
    { label: 'Time left after', width: 140 },
    { label: 'Cost', width: 120 },
    { label: 'Wallet after', width: 160 },
  ],
  dilute: [
    { label: 'New depth', width: 112 },
    { label: 'Time left after', width: 176 },
  ],
};

/** The least width the batch column keeps for the batch and its node's card under it. */
const BATCH_MIN_WIDTH = 256;

function widthOf(columns: readonly Column[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0);
}

/**
 * The table's least width: the tick, the batch's least, its readings and the widest operation's columns, so the batch
 * keeps its room whichever operation is on, and a narrow page scrolls the table rather than squeeze it.
 */
const TABLE_MIN_WIDTH =
  CHECKBOX_WIDTH +
  BATCH_MIN_WIDTH +
  widthOf(READING_COLUMNS) +
  Math.max(...Object.values(AFTER_COLUMNS).map((columns) => widthOf(columns)));

/** A header cell on one line, so the header row keeps one height whichever operation's columns it shows. */
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

/** An amount of xBZZ to three decimals, its token after it, and the exact amount as its tooltip. */
function Xbzz({ value }: { value: string }) {
  return (
    <Typography variant="body2" noWrap title={`${formatUnits(value, XBZZ_DECIMALS)} xBZZ`} sx={NUMBERS}>
      {formatShort(value, XBZZ_DECIMALS)} xBZZ
    </Typography>
  );
}

/** A batch's time left: `Expired` once it has run out, in the warning colour under two days, as the Stages page has it. */
function TimeLeft({ seconds }: { seconds: number | null }) {
  if (seconds === null) return <Dash />;
  if (seconds === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'error.main' }}>
        Expired
      </Typography>
    );
  }
  const low = seconds < STAMP_EXPIRY_WARNING_SECONDS;
  return (
    <Typography variant="body2" noWrap sx={{ ...NUMBERS, ...(low ? { color: 'warning.main' } : {}) }}>
      {formatTimeLeft(seconds)}
    </Typography>
  );
}

/** The batch's short id, the whole id on hover and with a copy button, and a chip when it is immutable. */
function BatchLine({ batch }: { batch: FundingBatch }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Typography variant="body2" noWrap title={batch.batchId} sx={{ fontFamily: monoFont }}>
        {shortHex(batch.batchId)}
      </Typography>
      <CopyButton value={batch.batchId} label="Batch id" />
      {batch.immutable ? <Chip size="small" variant="outlined" label="Immutable" /> : null}
    </Stack>
  );
}

/**
 * What the node's wallet holds after its ticked top-ups, all of them, since one wallet pays for each of its batches;
 * or, when it cannot pay for them, what it lacks in red, rounded up, with the exact amount on hover; and under either,
 * in red, that it holds no xDAI for the gas, as the Chequebooks tab's rows say it. Each is one line, so the cell stays
 * shorter than the batch's beside it and the row keeps its height. Fund all, beside the tab's button, enters what the
 * node lacks on the Balance tab.
 */
function WalletAfter({ ledger }: { ledger: NodeLedger | undefined }) {
  if (!ledger) return <Dash />;
  const { shortPlur, fundPlur, afterPlur, noGas } = ledger;
  let xbzz = afterPlur === null ? <Dash /> : <Xbzz value={afterPlur} />;
  if (shortPlur !== null && fundPlur !== null) {
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
  }
  if (!noGas) return xbzz;
  return (
    <Stack spacing={0.25} sx={{ alignItems: 'flex-end' }}>
      {xbzz}
      <Typography variant="body2" noWrap sx={{ color: 'error.main' }}>
        No xDAI for gas
      </Typography>
    </Stack>
  );
}

/** A ticked dilution's time left after, in red with the quote's own refusal under it when it would be under 7 days. */
function DiluteAfter({ line }: { line: StampLine }) {
  if (line.ttlAfterSeconds === null) return <Dash />;
  return (
    <Stack spacing={0.25} sx={{ alignItems: 'flex-end' }}>
      <Typography variant="body2" noWrap sx={{ ...NUMBERS, ...(line.problem ? { color: 'error.main' } : {}) }}>
        {formatTimeLeft(line.ttlAfterSeconds)}
      </Typography>
      {line.problem ? (
        <Typography variant="caption" sx={{ color: 'error.main', textAlign: 'right' }}>
          {line.problem}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * The cells a row fills in once it is ticked: dashes until then, so the row keeps its size. `node` is the row's own,
 * which names the node as its stage does; a batch two stages list is one line, under the first listing that can take
 * an operation.
 */
function AfterCells({
  operation,
  node,
  line,
  check,
}: {
  operation: FundingStampOperationKind;
  node: AdminFundingNode;
  line: StampLine | undefined;
  check: StampCheck | null;
}) {
  if (operation === 'dilute') {
    return (
      <>
        <TableCell align="right">
          {line?.newDepth == null ? (
            <Dash />
          ) : (
            <Typography variant="body2" sx={NUMBERS}>
              {line.newDepth}
            </Typography>
          )}
        </TableCell>
        <TableCell align="right">{line ? <DiluteAfter line={line} /> : <Dash />}</TableCell>
      </>
    );
  }
  return (
    <>
      <TableCell align="right">
        {line?.ttlAfterSeconds == null ? (
          <Dash />
        ) : (
          <Typography variant="body2" noWrap sx={{ ...NUMBERS, color: 'success.main' }}>
            {formatTimeLeft(line.ttlAfterSeconds)}
          </Typography>
        )}
      </TableCell>
      <TableCell align="right">{line?.costPlur ? <Xbzz value={line.costPlur} /> : <Dash />}</TableCell>
      <TableCell align="right">{line ? <WalletAfter ledger={check?.ledgerOf.get(node.nodeId)} /> : <Dash />}</TableCell>
    </>
  );
}

function BatchRowView({
  row,
  group,
  operation,
  ticked,
  check,
  onTick,
}: {
  row: BatchRow;
  group: BatchGroup;
  operation: FundingStampOperationKind;
  ticked: boolean;
  check: StampCheck | null;
  onTick: (batchId: string) => void;
}) {
  const { node, batch } = row;
  const why = whyNoTickBox(row);
  const verb = operation === 'topup' ? 'Top up' : 'Dilute';
  const line = why === null && ticked ? check?.lineOf.get(batch.batchId) : undefined;
  return (
    <TableRow selected={why === null && ticked}>
      <TableCell padding="checkbox">
        {why === null ? (
          <Checkbox
            checked={ticked}
            onChange={() => onTick(batch.batchId)}
            slotProps={{ input: { 'aria-label': `${verb} the batch of ${node.label}` } }}
          />
        ) : null}
      </TableCell>
      <TableCell>
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <BatchLine batch={batch} />
          <NodeCard node={node} group={group.nodes} />
        </Stack>
      </TableCell>
      <TableCell align="right">
        {batch.depth === null ? (
          <Dash />
        ) : (
          <Typography variant="body2" sx={NUMBERS}>
            {batch.depth}
          </Typography>
        )}
      </TableCell>
      <TableCell align="right">
        <TimeLeft seconds={batch.ttlSeconds} />
      </TableCell>
      <TableCell align="right">
        {batch.fillRatio === null ? (
          <Dash />
        ) : (
          <Typography variant="body2" sx={NUMBERS}>
            {formatPercent(batch.fillRatio)}
          </Typography>
        )}
      </TableCell>
      {why === null ? (
        <AfterCells operation={operation} node={node} line={line} check={check} />
      ) : (
        <TableCell colSpan={AFTER_COLUMNS[operation].length}>
          <Typography variant="body2" sx={{ color: batch.readError ? 'error.main' : 'text.secondary' }}>
            {why}
          </Typography>
        </TableCell>
      )}
    </TableRow>
  );
}

/**
 * One group of batches, the catalogue's or one stage's, a row each: the tick box, the batch with its node's card under
 * it, its depth, time left and fill, then, once it is ticked, what the operation leaves and costs. A batch that cannot
 * be ticked says why in place of those. The columns keep fixed widths, and no row changes its size when it is ticked.
 * The group's name has a tick box in front of it, in line with the rows' tick boxes, which ticks or clears every batch
 * of the group that has one; a batch two stages list is ticked by its id, so it shows ticked under both.
 */
export function BatchTable({
  group,
  operation,
  ticked,
  check,
  onTick,
  onTicks,
}: {
  group: BatchGroup;
  operation: FundingStampOperationKind;
  ticked: ReadonlySet<string>;
  check: StampCheck | null;
  onTick: (batchId: string) => void;
  /** Ticks every one of `batchIds`, or clears them: what the group's tick box asks for. */
  onTicks: (batchIds: readonly string[], tick: boolean) => void;
}) {
  const catalogue = group.nodes.catalogue;
  const verb = operation === 'topup' ? 'Top up' : 'Dilute';
  return (
    <Stack spacing={1}>
      <GroupTitle
        title={group.title}
        label={catalogue ? `${verb} the catalogue batch` : `${verb} every batch of ${group.title}`}
        keys={tickableBatches(group)}
        ticked={ticked}
        onTicks={onTicks}
      />
      {group.rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {catalogue ? 'The manager reports no catalogue batch.' : 'The manager reports no batch for this stage.'}
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table
            size="small"
            aria-label={catalogue ? 'Catalogue batch' : `Batches of ${group.title}`}
            sx={{ tableLayout: 'fixed', minWidth: TABLE_MIN_WIDTH }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ ...HEADER, width: CHECKBOX_WIDTH }} />
                <TableCell sx={HEADER}>Batch</TableCell>
                {[...READING_COLUMNS, ...AFTER_COLUMNS[operation]].map((column) => (
                  <TableCell key={column.label} align="right" sx={{ ...HEADER, width: column.width }}>
                    {column.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {group.rows.map((row, index) => (
                <BatchRowView
                  key={`${index}:${row.batch.batchId}`}
                  row={row}
                  group={group}
                  operation={operation}
                  ticked={ticked.has(row.batch.batchId)}
                  check={check}
                  onTick={onTick}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
