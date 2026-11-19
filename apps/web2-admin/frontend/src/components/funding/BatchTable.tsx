import type { ReactNode } from 'react';
import {
  Button,
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
  BATCH_PURCHASE_MOVE_OFF,
  operableBatch,
  STAMP_EXPIRY_WARNING_SECONDS,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type ArchiveStamp,
  type BatchPurchase,
  type FundingBatch,
  type FundingStampOperationKind,
} from '@streaming-monorepo/web2-admin-common';

import { formatPercent, formatTimeLeft, shortHex } from '../../format';
import { CHUNK_BYTES, formatCapacity } from '../archive/archiveText';
import { CopyButton } from '../CopyButton';
import { formatShort, formatUnits } from './amounts';
import { BatchPurchaseLines } from './BatchPurchaseLines';
import {
  NO_BATCH_SET,
  PURCHASE_TO_CHECK,
  PURCHASE_UNDER_WAY,
  purchaseHoldsNode,
  purchaseOpen,
  type BuyOffer,
} from './batchPurchases';
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

/** `1 quality`, `3 qualities`. */
function qualityCount(count: number): string {
  return `${count} ${count === 1 ? 'quality' : 'qualities'}`;
}

/**
 * Under an archive stamp's id, in place of a node's card: its label, whether it is topped up only, the node that holds
 * it, its room and the qualities on it as the admin read them, and a warning when its time left is under the warning
 * threshold.
 */
function ArchiveLines({
  stamp,
  holder,
  operable,
  warningDays,
}: {
  stamp: ArchiveStamp;
  holder: AdminFundingNode;
  /**
   * Whether the stamp can take an operation at all, so "Top-ups only" is worth saying: its batch can, and it is not on
   * a node that is the catalogue node no longer, which the admin neither tops up nor dilutes.
   */
  operable: boolean;
  warningDays: number | null;
}) {
  const facts = [
    `On ${holder.label}`,
    stamp.roomChunks !== null ? `Room for ${formatCapacity(stamp.roomChunks * CHUNK_BYTES)}` : null,
    `${qualityCount(stamp.qualitiesArchived)} on it`,
  ].filter((fact): fact is string => fact !== null);
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
          {stamp.label ?? 'No label'}
        </Typography>
        {!stamp.writable && operable ? <Chip size="small" variant="outlined" label="Top-ups only" /> : null}
      </Stack>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {facts.join(' · ')}
      </Typography>
      {stamp.expiresSoon ? (
        <Typography variant="caption" sx={{ color: 'warning.main' }}>
          {warningDays === null ? 'Its time left is running low.' : `Under ${warningDays} days left.`}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * What the tab gives a group for Buy new: the offer a node's row makes, the latest purchase of a node, whether the
 * catalogue move is switched off, and what Buy new, Restart now and Check again ask for.
 */
export interface BuyControls {
  offerOf: (node: AdminFundingNode) => BuyOffer | null;
  purchaseOf: (nodeId: string) => BatchPurchase | undefined;
  /** True while `CATALOGUE_MOVE_ENABLED` is off, when the catalogue's row says so in place of Buy new. */
  moveOff: boolean;
  onBuy: (offer: BuyOffer) => void;
  onRestart: (purchaseId: string, stageId: string) => Promise<void>;
  onCheck: (purchaseId: string) => Promise<void>;
}

/**
 * Buy new on a node's row, or why there is none: a purchase on the node is under way or waits for Check again, or the
 * catalogue move is switched off. Nothing for a node whose batch still pays.
 */
function BuyAction({ node, buy }: { node: AdminFundingNode; buy: BuyControls }) {
  const purchase = buy.purchaseOf(node.nodeId);
  if (purchase && purchaseHoldsNode(purchase)) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {purchaseOpen(purchase) ? PURCHASE_UNDER_WAY : PURCHASE_TO_CHECK}
      </Typography>
    );
  }
  const offer = buy.offerOf(node);
  if (!offer) return null;
  if (offer.purpose === 'catalogue' && buy.moveOff) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {BATCH_PURCHASE_MOVE_OFF}
      </Typography>
    );
  }
  return (
    <Button
      size="small"
      variant="contained"
      onClick={() => buy.onBuy(offer)}
      aria-label={offer.purpose === 'catalogue' ? 'Buy a new catalogue batch' : `Buy a new batch for ${node.label}`}
    >
      Buy new
    </Button>
  );
}

/** The cell after the readings of a row with no tick box: why, and Buy new or why there is none. */
function WhyCell({
  why,
  error,
  node,
  buy,
  columns,
}: {
  why: string | null;
  error: boolean;
  node: AdminFundingNode;
  buy: BuyControls | null;
  columns: number;
}) {
  return (
    <TableCell colSpan={columns}>
      <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
        {why ? (
          <Typography variant="body2" sx={{ color: error ? 'error.main' : 'text.secondary' }}>
            {why}
          </Typography>
        ) : null}
        {buy ? <BuyAction node={node} buy={buy} /> : null}
      </Stack>
    </TableCell>
  );
}

/** Every column of a row: the tick, the batch, its readings and the operation's. */
function columnCount(operation: FundingStampOperationKind): number {
  return 2 + READING_COLUMNS.length + AFTER_COLUMNS[operation].length;
}

/** Under a node's row, its latest purchase, across every column but the tick's. */
function PurchaseRow({ node, buy, columns }: { node: AdminFundingNode; buy: BuyControls | null; columns: number }) {
  const purchase = buy?.purchaseOf(node.nodeId);
  if (!buy || !purchase) return null;
  return (
    <TableRow>
      <TableCell />
      <TableCell colSpan={columns - 1}>
        <BatchPurchaseLines purchase={purchase} onRestart={buy.onRestart} onCheck={buy.onCheck} />
      </TableCell>
    </TableRow>
  );
}

/** The row of a node with no batch, which the manager recommends one for: its card, and Buy new. */
function MissingRowView({
  node,
  group,
  operation,
  buy,
}: {
  node: AdminFundingNode;
  group: BatchGroup;
  operation: FundingStampOperationKind;
  buy: BuyControls | null;
}) {
  return (
    <>
      <TableRow>
        <TableCell padding="checkbox" />
        <TableCell>
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              No batch
            </Typography>
            <NodeCard node={node} group={group.nodes} />
          </Stack>
        </TableCell>
        {READING_COLUMNS.map((column) => (
          <TableCell key={column.label} align="right">
            <Dash />
          </TableCell>
        ))}
        <WhyCell why={NO_BATCH_SET} error={false} node={node} buy={buy} columns={AFTER_COLUMNS[operation].length} />
      </TableRow>
      <PurchaseRow node={node} buy={buy} columns={columnCount(operation)} />
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
  warningDays,
  buy,
}: {
  row: BatchRow;
  group: BatchGroup;
  operation: FundingStampOperationKind;
  ticked: boolean;
  check: StampCheck | null;
  onTick: (batchId: string) => void;
  warningDays: number | null;
  /** Buy new and the purchases, for a row of a node's own batch; null for an archive stamp's. */
  buy: BuyControls | null;
}) {
  const { node, batch } = row;
  const why = whyNoTickBox(row, operation);
  const verb = operation === 'topup' ? 'Top up' : 'Dilute';
  const line = why === null && ticked ? check?.lineOf.get(batch.batchId) : undefined;
  return (
    <>
      <TableRow selected={why === null && ticked}>
        <TableCell padding="checkbox">
          {why === null ? (
            <Checkbox
              checked={ticked}
              onChange={() => onTick(batch.batchId)}
              slotProps={{
                input: {
                  'aria-label': row.archive
                    ? `${verb} the archive stamp ${row.archive.label ?? shortHex(batch.batchId)}`
                    : `${verb} the batch of ${node.label}`,
                },
              }}
            />
          ) : null}
        </TableCell>
        <TableCell>
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <BatchLine batch={batch} />
            {row.archive ? (
              <ArchiveLines
                stamp={row.archive}
                holder={node}
                operable={operableBatch(batch) && !row.formerCatalogue}
                warningDays={warningDays}
              />
            ) : (
              <NodeCard node={node} group={group.nodes} />
            )}
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
          <WhyCell
            why={why}
            error={batch.readError !== null}
            node={node}
            buy={buy}
            columns={AFTER_COLUMNS[operation].length}
          />
        )}
      </TableRow>
      <PurchaseRow node={node} buy={buy} columns={columnCount(operation)} />
    </>
  );
}

/** Said in the archive group while the catalogue node has no archive stamp. */
export const NO_ARCHIVE_STAMPS = 'No archive stamps yet.';

const NO_ROWS: Readonly<Record<BatchGroup['kind'], string>> = {
  catalogue: 'The manager reports no catalogue batch.',
  archive: NO_ARCHIVE_STAMPS,
  stage: 'The manager reports no batch for this stage.',
};

function groupTickLabel(group: BatchGroup, verb: string): string {
  if (group.kind === 'catalogue') return `${verb} the catalogue batch`;
  if (group.kind === 'archive') return `${verb} every archive stamp`;
  return `${verb} every batch of ${group.title}`;
}

function tableLabel(group: BatchGroup): string {
  if (group.kind === 'catalogue') return 'Catalogue batch';
  if (group.kind === 'archive') return 'Archive stamps';
  return `Batches of ${group.title}`;
}

/**
 * One group of batches, the catalogue's, the archive stamps or one stage's, a row each: the tick box, the batch with
 * its node's card under it, or an archive stamp's label, room and qualities, its depth, time left and fill, then, once
 * it is ticked, what the operation leaves and costs. A batch that cannot be ticked says why in place of those. The
 * columns keep fixed widths, and no row changes its size when it is ticked. The group's name has a tick box in front
 * of it, in line with the rows' tick boxes, which ticks or clears every batch of the group that has one; a batch two
 * stages list is ticked by its id, so it shows ticked under both. `footer`, under the rows, is the archive group's
 * purchases and its Buy button.
 *
 * With `buy`, a row whose batch no longer pays offers Buy new beside why it has no tick box, as does the row of a node
 * with no batch, which the group lists after the rest; and under a node's row comes its latest purchase, with a line
 * for each stage, Restart now, Check again and the catalogue's move.
 */
export function BatchTable({
  group,
  operation,
  ticked,
  check,
  onTick,
  onTicks,
  warningDays = null,
  footer = null,
  buy = null,
}: {
  group: BatchGroup;
  operation: FundingStampOperationKind;
  ticked: ReadonlySet<string>;
  check: StampCheck | null;
  onTick: (batchId: string) => void;
  /** Ticks every one of `batchIds`, or clears them: what the group's tick box asks for. */
  onTicks: (batchIds: readonly string[], tick: boolean) => void;
  /** The days under which an archive stamp's time left is warned about, or null when they were not read. */
  warningDays?: number | null;
  footer?: ReactNode;
  /** Buy new and the purchases of the group's nodes; left out, as for the archive stamps, no row offers a purchase. */
  buy?: BuyControls | null;
}) {
  const verb = operation === 'topup' ? 'Top up' : 'Dilute';
  return (
    <Stack spacing={1}>
      <GroupTitle
        title={group.title}
        label={groupTickLabel(group, verb)}
        keys={tickableBatches(group, operation)}
        ticked={ticked}
        onTicks={onTicks}
      />
      {group.rows.length === 0 && group.missing.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {NO_ROWS[group.kind]}
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label={tableLabel(group)} sx={{ tableLayout: 'fixed', minWidth: TABLE_MIN_WIDTH }}>
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
                  warningDays={warningDays}
                  buy={row.archive ? null : buy}
                />
              ))}
              {group.missing.map((node) => (
                <MissingRowView
                  key={`missing:${node.nodeId}`}
                  node={node}
                  group={group}
                  operation={operation}
                  buy={buy}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {footer}
    </Stack>
  );
}
