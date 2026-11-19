import { useEffect, useRef } from 'react';
import { Radio, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';
import { XBZZ_DECIMALS } from '@streaming-monorepo/web2-admin-common';

import { chunkCount, formatCapacity } from '../archive/archiveText';
import { formatShort, formatUnits } from './amounts';

/** One depth a buy dialog offers: what a batch of it holds, in bytes and in chunks, and what it costs for the days. */
export interface DepthRow {
  depth: number;
  bytes: number;
  chunks: number;
  costPlur: string;
}

/**
 * The size half of the buy dialogs' calculator, the archive stamp's and Buy new's: one row per depth with what it holds
 * and what it costs for the days chosen; the row picked is the one to buy. With `scrollToPicked`, the picked row is
 * scrolled into the box when the rows are first drawn, for a list longer than the box.
 */
export function DepthRows({
  rows,
  depth,
  onPick,
  disabled,
  scrollToPicked = false,
}: {
  rows: readonly DepthRow[];
  depth: number | null;
  onPick: (depth: number) => void;
  disabled: boolean;
  scrollToPicked?: boolean;
}) {
  const picked = useRef<HTMLTableRowElement | null>(null);
  const scroll = useRef(scrollToPicked);
  useEffect(() => {
    // Only when first drawn, since a row picked by a click is in view already. jsdom has no scrollIntoView.
    if (scroll.current) picked.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <TableContainer sx={{ maxHeight: 320 }}>
      <Table size="small" stickyHeader aria-label="Depths">
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox" />
            <TableCell>Depth</TableCell>
            <TableCell align="right">Holds</TableCell>
            <TableCell align="right">Costs</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const isPicked = row.depth === depth;
            return (
              <TableRow
                key={row.depth}
                ref={isPicked ? picked : undefined}
                hover={!disabled}
                selected={isPicked}
                onClick={disabled ? undefined : () => onPick(row.depth)}
                sx={{ cursor: disabled ? 'default' : 'pointer' }}
              >
                <TableCell padding="checkbox">
                  <Radio
                    size="small"
                    checked={isPicked}
                    disabled={disabled}
                    onChange={() => onPick(row.depth)}
                    slotProps={{ input: { 'aria-label': `Depth ${row.depth}` } }}
                  />
                </TableCell>
                <TableCell>{row.depth}</TableCell>
                <TableCell align="right" title={chunkCount(row.chunks)}>
                  {formatCapacity(row.bytes)}
                </TableCell>
                <TableCell
                  align="right"
                  title={`${formatUnits(row.costPlur, XBZZ_DECIMALS)} xBZZ`}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {`${formatShort(row.costPlur, XBZZ_DECIMALS)} xBZZ`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
