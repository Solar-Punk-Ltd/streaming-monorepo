import { Alert, Paper, Stack, Typography } from '@mui/material';
import type { CatalogueStampSummary } from '@streaming-monorepo/web2-admin-common';

import { formatAgo } from '../../dateUtil';
import { shortHex } from '../../format';
import { StampNumbers, StampStateChip, stampConcern } from './stamps';

export const NO_CATALOGUE_STAMP = 'The manager has not designated a catalogue batch yet.';

/**
 * The brand's catalogue batch, as the manager last read it. The catalogue is not written through it yet; this card
 * says what the manager designated and how much life it has left.
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
            {concern === 'gone' ? (
              <Alert severity="error">
                The catalogue batch is {stamp.state}. Nothing can be written to the catalogue with it.
              </Alert>
            ) : null}
            {concern === 'low' ? (
              <Alert severity="warning">
                The catalogue batch has less than 48 hours left. Top it up in the manager.
              </Alert>
            ) : null}
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <StampStateChip state={stamp.state} />
              <Typography variant="body2">
                Batch {shortHex(stamp.batchId)} on {stamp.nodeName}
              </Typography>
            </Stack>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {stamp.immutable ? 'Immutable' : 'Mutable'}, depth {stamp.depth}
            </Typography>
            <StampNumbers state={stamp.state} ttlSeconds={stamp.ttlSeconds} fillRatio={stamp.fillRatio} />
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
