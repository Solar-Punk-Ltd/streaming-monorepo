import { Alert, Stack } from '@mui/material';
import { CATALOGUE_FILL_WARNING_RATIO, type CatalogueWriteStatus } from '@streaming-monorepo/web2-admin-common';

import { formatAgo } from '../../dateUtil';
import { formatPercent } from '../../format';
import { stampConcern } from './stamps';

/** `ab12cd34…`: the batch as the admin's own sentences name it. */
function shortBatch(batchId: string): string {
  return `${batchId.slice(0, 8)}…`;
}

/**
 * What My Streams says about the catalogue batch before anyone presses Publish: that the admin refuses to write the
 * catalogue and why, in the sentence it refuses with; that the batch it writes with has less than 48 hours left or
 * is at least 90% full; and that a move to the batch the manager designated is waiting. Nothing when all is well.
 */
export function CatalogueWriteBanner({ status, now }: { status: CatalogueWriteStatus | null; now: number }) {
  if (!status) return null;
  const { batch, refusal, moveWaitingTo } = status;

  const alerts: { key: string; severity: 'error' | 'warning' | 'info'; text: string }[] = [];
  if (refusal) {
    alerts.push({ key: 'refusal', severity: 'error', text: refusal.message });
  } else if (batch) {
    if (stampConcern(batch) === 'low') {
      alerts.push({
        key: 'ttl',
        severity: 'warning',
        text: `The catalogue batch ${shortBatch(batch.batchId)} has less than 48 hours left. Top it up in the manager.`,
      });
    }
    if (batch.fillRatio !== null && batch.fillRatio >= CATALOGUE_FILL_WARNING_RATIO) {
      alerts.push({
        key: 'fill',
        severity: 'warning',
        text: `The catalogue batch ${shortBatch(batch.batchId)} is ${formatPercent(batch.fillRatio)} full. Once it is full, nothing more can be written to the catalogue with it.`,
      });
    }
  }
  if (moveWaitingTo && batch) {
    alerts.push({
      key: 'move',
      severity: 'info',
      text: `A move to batch ${shortBatch(moveWaitingTo)} is waiting. Until it runs, the catalogue is written with batch ${shortBatch(batch.batchId)}, as the manager last read it ${formatAgo(batch.observedAt, now)}.`,
    });
  }

  if (alerts.length === 0) return null;
  return (
    <Stack spacing={1}>
      {alerts.map((alert) => (
        <Alert key={alert.key} severity={alert.severity}>
          {alert.text}
        </Alert>
      ))}
    </Stack>
  );
}
