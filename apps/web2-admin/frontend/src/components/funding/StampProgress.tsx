import { Stack, TableCell, Typography } from '@mui/material';
import { XBZZ_DECIMALS, type FundingStampItem } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { shortHex } from '../../format';
import { monoFont } from '../../theme/createAdminTheme';
import { formatUnits } from './amounts';
import { BulkProgress, type BulkWords } from './BulkProgress';
import { dayCount, stepCount } from './stamps';

/**
 * Said under a stamp operation the manager answers `unknown` that is not settled yet: the node's answer was lost, and
 * its transaction may still be mined, so the next stamp bulk waits until the manager can tell, or its 30 minutes pass.
 */
export const STAMP_NOT_KNOWN_YET_NOTE =
  "The manager cannot tell yet whether the node's transaction went through, so a new stamp operation waits until it can, 30 minutes at most.";

/**
 * Said under a stamp operation the manager answers `unknown` and the server counts as settled: one the manager has not
 * seen on the chain for its 30 minutes. It says no more than that, so the operator looks at the batch before asking
 * again.
 */
export const STAMP_DROPPED_NOTE =
  'The manager has not seen it on the chain for 30 minutes. Check the batch before you ask for it again.';

/**
 * Said under the operations: a node reads a batch's new time left and depth back from the chain a little after the
 * transaction is mined, so the batches the page reads again once the operations have settled may not show it yet.
 */
export const READ_BACK_NOTE =
  'A batch shows its new time left or depth once its node has read it back from the chain, usually within a minute. Refresh to read the batches again.';

const WORDS: BulkWords = {
  title: 'Stamp operations',
  one: 'stamp operation',
  many: 'stamp operations',
  mayYet: 'go through',
};

function noteOf(item: FundingStampItem): string | null {
  if (item.state !== 'unknown') return null;
  return item.settled ? STAMP_DROPPED_NOTE : STAMP_NOT_KNOWN_YET_NOTE;
}

/** What an operation does: `Top up 30 days, 1.5 xBZZ`, or `Dilute 1 step`. */
export function stampWhat(item: FundingStampItem): string {
  if (item.kind === 'dilute') return item.steps === null ? 'Dilute' : `Dilute ${stepCount(item.steps)}`;
  const parts = ['Top up'];
  if (item.days !== null) parts.push(` ${dayCount(item.days)}`);
  if (item.costPlur !== null) parts.push(`, ${formatUnits(item.costPlur, XBZZ_DECIMALS)} xBZZ`);
  return parts.join('');
}

/**
 * The operations of one stamp bulk, item by item, as `BulkProgress` follows a bulk: each node and batch, what it does,
 * then where it stands. A new stamp bulk is free again once the server says every operation is `settled`.
 */
export function StampProgress({
  bulkId,
  initial,
  onSettled,
  onDismiss,
}: {
  bulkId: string;
  /** What the request answered, or none for a bulk the page resumed from the view's `openStampBulkId`. */
  initial: readonly FundingStampItem[];
  /** Said when the operations no longer hold the next bulk back, and again each time one more comes to its end. */
  onSettled: () => void;
  onDismiss: () => void;
}) {
  return (
    <BulkProgress
      bulkId={bulkId}
      initial={initial}
      words={WORDS}
      read={api.fetchFundingStampOperations}
      describe={(item) => (
        <>
          <TableCell>
            <Stack spacing={0.25}>
              <Typography variant="body2">{item.nodeLabel}</Typography>
              <Typography variant="caption" title={item.batchId} sx={{ fontFamily: monoFont, color: 'text.secondary' }}>
                {shortHex(item.batchId)}
              </Typography>
            </Stack>
          </TableCell>
          <TableCell align="right">{stampWhat(item)}</TableCell>
        </>
      )}
      note={noteOf}
      footnote={READ_BACK_NOTE}
      onSettled={onSettled}
      onDismiss={onDismiss}
    />
  );
}
