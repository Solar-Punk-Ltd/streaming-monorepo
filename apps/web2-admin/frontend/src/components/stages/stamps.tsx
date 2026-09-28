import { Chip, Stack, Typography } from '@mui/material';
import {
  STAMP_EXPIRY_WARNING_SECONDS,
  type StageChequebookHealth,
  type StageReadinessTone,
  type StageStampState,
} from '@streaming-monorepo/web2-admin-common';

import { formatPercent, formatTimeLeft } from '../../format';

type ChipColor = 'default' | 'success' | 'warning' | 'error' | 'info';

/**
 * What a batch reading is worth warning about: `gone` when the batch is expired or gone, `low` when it has less than
 * two days left (`STAMP_EXPIRY_WARNING_SECONDS`, the manager's own threshold), null otherwise. A negative time to
 * live is Bee saying it cannot tell, not that the batch ran out.
 */
export type StampConcern = 'gone' | 'low' | null;

export function stampConcern(stamp: { state: StageStampState; ttlSeconds: number | null } | null): StampConcern {
  if (!stamp) return null;
  if (stamp.state === 'expired' || stamp.state === 'gone') return 'gone';
  if (stamp.ttlSeconds !== null && stamp.ttlSeconds >= 0 && stamp.ttlSeconds < STAMP_EXPIRY_WARNING_SECONDS) {
    return 'low';
  }
  return null;
}

const STAMP_STATE_LABEL: Record<StageStampState, string> = {
  none: 'No batch',
  unknown: 'Unknown',
  active: 'Active',
  pending: 'Pending',
  full: 'Full',
  expired: 'Expired',
  gone: 'Gone',
};

const STAMP_STATE_COLOR: Record<StageStampState, ChipColor> = {
  none: 'default',
  unknown: 'default',
  active: 'success',
  pending: 'info',
  full: 'warning',
  expired: 'error',
  gone: 'error',
};

export function StampStateChip({ state }: { state: StageStampState }) {
  return <Chip size="small" variant="outlined" label={STAMP_STATE_LABEL[state]} color={STAMP_STATE_COLOR[state]} />;
}

/** `5 days 0 h left, 25% full`, in the warning colour under two days and the error colour once it is gone. */
export function StampNumbers({
  state,
  ttlSeconds,
  fillRatio,
}: {
  state: StageStampState;
  ttlSeconds: number | null;
  fillRatio: number | null;
}) {
  const concern = stampConcern({ state, ttlSeconds });
  const color = concern === 'gone' ? 'error.main' : concern === 'low' ? 'warning.main' : 'text.secondary';
  return (
    <Typography variant="caption" sx={{ color }}>
      {formatTimeLeft(ttlSeconds)} left, {formatPercent(fillRatio)} full
      {concern === 'low' ? ' (under 48 h)' : null}
    </Typography>
  );
}

const READINESS_LABEL: Record<StageReadinessTone, string> = {
  ready: 'Ready',
  warning: 'Warning',
  blocked: 'Blocked',
  unknown: 'Unknown',
};

const READINESS_COLOR: Record<StageReadinessTone, ChipColor> = {
  ready: 'success',
  warning: 'warning',
  blocked: 'error',
  unknown: 'default',
};

/** The manager's verdict on a stage, with the reasons it gave, as it gave them. */
export function ReadinessChip({ tone, reasons }: { tone: StageReadinessTone; reasons: string[] }) {
  return (
    <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
      <Chip size="small" label={READINESS_LABEL[tone]} color={READINESS_COLOR[tone]} />
      {reasons.map((reason) => (
        <Typography key={reason} variant="caption" sx={{ color: 'text.secondary' }}>
          {reason}
        </Typography>
      ))}
    </Stack>
  );
}

const CHEQUEBOOK_LABEL: Record<StageChequebookHealth, string> = {
  unknown: 'Chequebook unknown',
  ok: 'Chequebook OK',
  low: 'Chequebook low',
  empty: 'Chequebook empty',
};

const CHEQUEBOOK_COLOR: Record<StageChequebookHealth, ChipColor> = {
  unknown: 'default',
  ok: 'success',
  low: 'warning',
  empty: 'error',
};

export function ChequebookChip({ health }: { health: StageChequebookHealth }) {
  return <Chip size="small" variant="outlined" label={CHEQUEBOOK_LABEL[health]} color={CHEQUEBOOK_COLOR[health]} />;
}
