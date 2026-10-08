import { TableCell } from '@mui/material';
import type { FundingChequebookItem } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { BulkProgress, type BulkWords } from './BulkProgress';
import { moveText } from './chequebooks';

/**
 * Said under a chequebook operation the manager answers `unknown` that is not settled yet: the node's answer was lost,
 * and its transaction may still be mined, so the next chequebook bulk waits until the manager can tell, or its 30
 * minutes pass.
 */
export const CHEQUEBOOK_NOT_KNOWN_YET_NOTE =
  "The manager cannot tell yet whether the node's transaction went through, so a new chequebook operation waits until it can, 30 minutes at most.";

/**
 * Said under a chequebook operation the manager answers `unknown` and the server counts as settled: one the manager
 * has not seen on the chain for its 30 minutes. It says no more than that, so the operator looks at the chequebook
 * before asking again.
 */
export const CHEQUEBOOK_DROPPED_NOTE =
  'The manager has not seen it on the chain for 30 minutes. Check the chequebook before you ask for it again.';

/**
 * Said under the operations: the page reads the chequebooks again once the operations have settled, and a busy
 * node's balance is near the target then, not on it.
 */
export const CHEQUEBOOK_READ_AGAIN_NOTE =
  'The page reads the chequebooks again once the operations have settled. A busy node keeps paying its peers, so its balance lands near the target, not on it.';

const WORDS: BulkWords = {
  title: 'Chequebook operations',
  one: 'chequebook operation',
  many: 'chequebook operations',
  mayYet: 'go through',
};

function noteOf(item: FundingChequebookItem): string | null {
  if (item.state !== 'unknown') return null;
  return item.settled ? CHEQUEBOOK_DROPPED_NOTE : CHEQUEBOOK_NOT_KNOWN_YET_NOTE;
}

/**
 * The operations of one chequebook bulk, item by item, as `BulkProgress` follows a bulk: each node and its move, every
 * digit of its amount as the API journalled it, which may be less than the confirm dialog listed, then where it
 * stands. A new chequebook bulk is free again once the server says every operation is `settled`.
 */
export function ChequebookProgress({
  bulkId,
  initial,
  onSettled,
  onDismiss,
}: {
  bulkId: string;
  /** What the request answered, or none for a bulk the page resumed from the view's `openChequebookBulkId`. */
  initial: readonly FundingChequebookItem[];
  /** Said when the operations no longer hold the next bulk back, and again each time one more comes to its end. */
  onSettled: () => void;
  onDismiss: () => void;
}) {
  return (
    <BulkProgress
      bulkId={bulkId}
      initial={initial}
      words={WORDS}
      read={api.fetchFundingChequebookOperations}
      describe={(item) => (
        <>
          <TableCell>{item.nodeLabel}</TableCell>
          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {moveText({ direction: item.direction, amountPlur: item.amountPlur })}
          </TableCell>
        </>
      )}
      note={noteOf}
      footnote={CHEQUEBOOK_READ_AGAIN_NOTE}
      onSettled={onSettled}
      onDismiss={onDismiss}
    />
  );
}
