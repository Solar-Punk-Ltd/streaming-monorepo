import { TableCell } from '@mui/material';
import type { FundingTransferItem } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatUnits } from './amounts';
import { TOKENS } from './balance';
import { BULK_POLL_LIMIT_MS, BULK_POLL_MS, BulkProgress, type BulkWords } from './BulkProgress';

/** How often the transfers of a bulk are read again while any of them can still change. */
export const TRANSFER_POLL_MS = BULK_POLL_MS;

/** How long the page keeps reading a bulk whose transfers can still change, before it offers Check again. */
export const TRANSFER_POLL_LIMIT_MS = BULK_POLL_LIMIT_MS;

/**
 * Said under a transfer the manager answers `unknown` and the server counts as settled: one the manager has not seen
 * on the chain for its 30 minutes. It says no more than that, since the chain may still hold it. A failed transfer has
 * no such line: the admin's own sentence says why it failed, and of one the chain's node refused, that it may still
 * arrive and to check the node's balance before sending again.
 */
export const DROPPED_NOTE =
  'The manager has not seen it on the chain for 30 minutes, so a new send reuses its nonce. At most one of the two can arrive.';

/**
 * Said under a transfer the manager answers `unknown` that is not settled yet: the answer of its broadcast was lost,
 * and it may sit in the chain's pool, so Send waits until the manager can tell, or its 30 minutes pass.
 */
export const NOT_KNOWN_YET_NOTE =
  'The manager cannot tell yet whether the chain took it, so Send waits until it can, 30 minutes at most.';

const WORDS: BulkWords = { title: 'Transfers', one: 'transfer', many: 'transfers', mayYet: 'arrive' };

function noteOf(item: FundingTransferItem): string | null {
  if (item.state !== 'unknown') return null;
  return item.settled ? DROPPED_NOTE : NOT_KNOWN_YET_NOTE;
}

/**
 * The transfers of one send, item by item, as `BulkProgress` follows a bulk: each node and amount, then where it
 * stands. Send is free again once the server says every transfer is `settled`.
 */
export function TransferProgress({
  bulkId,
  initial,
  labels,
  onSettled,
  onDismiss,
}: {
  bulkId: string;
  /** What the send answered, or none for a send the page resumed from the view's `openBulkId`. */
  initial: readonly FundingTransferItem[];
  labels: ReadonlyMap<string, string>;
  /** Said when the transfers no longer hold Send back, and again each time one more comes to its end after that. */
  onSettled: () => void;
  onDismiss: () => void;
}) {
  return (
    <BulkProgress
      bulkId={bulkId}
      initial={initial}
      words={WORDS}
      read={api.fetchFundingTransfers}
      describe={(item) => (
        <>
          <TableCell>{labels.get(item.nodeId) ?? item.nodeId}</TableCell>
          <TableCell align="right">
            {formatUnits(item.amount, TOKENS[item.kind].decimals)} {TOKENS[item.kind].name}
          </TableCell>
        </>
      )}
      note={noteOf}
      onSettled={onSettled}
      onDismiss={onDismiss}
    />
  );
}
