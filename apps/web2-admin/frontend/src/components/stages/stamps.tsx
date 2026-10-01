import { Chip, Stack, Typography } from '@mui/material';
import {
  STAMP_EXPIRY_WARNING_SECONDS,
  type StageChequebookHealth,
  type StageReadinessTone,
  type StageStampState,
  type StampReadingAge,
} from '@streaming-monorepo/web2-admin-common';

import { formatPercent, formatTimeLeft } from '../../format';

type ChipColor = 'default' | 'success' | 'warning' | 'error' | 'info';

/**
 * What a batch reading is worth warning about: `gone` when the batch is expired or gone, or expired by the clock (the
 * time to live the manager last read for it has run out since, which the admin refuses a catalogue write for), `low`
 * when it has less than two days left (`STAMP_EXPIRY_WARNING_SECONDS`, the manager's own threshold), null otherwise.
 * The time left is the one the API aged to the moment it answered, never the reading's `ttlSeconds` as it is. An
 * unknown one is Bee saying it cannot tell, not that the batch ran out.
 */
export type StampConcern = 'gone' | 'low' | null;

export function stampConcern(stamp: ({ state: StageStampState } & StampReadingAge) | null): StampConcern {
  if (!stamp) return null;
  if (stamp.state === 'expired' || stamp.state === 'gone' || stamp.expiredByClock) return 'gone';
  if (stamp.remainingSeconds !== null && stamp.remainingSeconds < STAMP_EXPIRY_WARNING_SECONDS) return 'low';
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

/**
 * The batch's state as the manager last read it, or `Expired by the clock` in the error colour once the time to live
 * of that reading has run out, whatever state it gave.
 */
export function StampStateChip({ state, expiredByClock }: { state: StageStampState; expiredByClock: boolean }) {
  if (expiredByClock) return <Chip size="small" variant="outlined" label="Expired by the clock" color="error" />;
  return <Chip size="small" variant="outlined" label={STAMP_STATE_LABEL[state]} color={STAMP_STATE_COLOR[state]} />;
}

/**
 * `5 days 0 h left, 25% full`, the time left as of the API's answer, in the warning colour under two days and the
 * error colour once it is gone; `Expired by the clock, 25% full` once that time has run out.
 */
export function StampNumbers({
  state,
  remainingSeconds,
  expiredByClock,
  fillRatio,
}: { state: StageStampState; fillRatio: number | null } & StampReadingAge) {
  const concern = stampConcern({ state, remainingSeconds, expiredByClock });
  const color = concern === 'gone' ? 'error.main' : concern === 'low' ? 'warning.main' : 'text.secondary';
  const left = expiredByClock ? 'Expired by the clock' : `${formatTimeLeft(remainingSeconds)} left`;
  return (
    <Typography variant="caption" sx={{ color }}>
      {left}, {formatPercent(fillRatio)} full
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
