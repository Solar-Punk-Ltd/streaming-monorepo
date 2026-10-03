import { Alert, Paper, Stack, Typography } from '@mui/material';
import type { CatalogueStampSummary } from '@streaming-monorepo/web2-admin-common';

import { formatAgo } from '../../dateUtil';
import { shortHex } from '../../format';
import { StampNumbers, StampStateChip, stampConcern } from './stamps';

export const NO_CATALOGUE_STAMP = 'The manager has not designated a catalogue batch yet.';

/** What the card says of a batch that is gone: its state, or that its time to live ran out since it was read. */
function goneText(stamp: CatalogueStampSummary): string {
  if (stamp.state === 'expired' || stamp.state === 'gone') {
    return `The catalogue batch is ${stamp.state}. Nothing can be written to the catalogue with it.`;
  }
  return 'The catalogue batch is expired by the clock: the time to live the manager last read for it has run out. Nothing can be written to the catalogue with it.';
}

/**
 * The brand's catalogue batch, as the manager last read it: what the manager designated and how much life it has
 * left now, aged from that reading by the API as the admin's refusal ages it. The catalogue is written through it, or
 * through the batch the admin pinned while a move to it waits; My Streams says which, and warns.
 */
export function CatalogueStampCard({ stamp, now }: { stamp: CatalogueStampSummary | null; now: number }) {
  const concern = stampConcern(stamp);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" component="h2">
          Catalogue stamp
        </Typography>

        {stamp ? (
          <>
            {concern === 'gone' ? <Alert severity="error">{goneText(stamp)}</Alert> : null}
            {concern === 'low' ? (
              <Alert severity="warning">
                The catalogue batch has less than 48 hours left. Top it up in the manager.
              </Alert>
            ) : null}
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <StampStateChip state={stamp.state} expiredByClock={stamp.expiredByClock} />
              <Typography variant="body2">
                Batch {shortHex(stamp.batchId)} on {stamp.nodeName}
              </Typography>
            </Stack>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {stamp.immutable ? 'Immutable' : 'Mutable'}, depth {stamp.depth}
            </Typography>
            <StampNumbers
              state={stamp.state}
              remainingSeconds={stamp.remainingSeconds}
              expiredByClock={stamp.expiredByClock}
              fillRatio={stamp.fillRatio}
            />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Last confirmed {formatAgo(stamp.observedAt, now)}
            </Typography>
          </>
        ) : (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {NO_CATALOGUE_STAMP}
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}
