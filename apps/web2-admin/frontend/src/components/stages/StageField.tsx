import { Alert, Box, TextField } from '@mui/material';
import { sameFeedOwner, type StageSummary } from '@streaming-monorepo/web2-admin-common';

import { formatAgo } from '../../dateUtil';
import { shortHex } from '../../format';

/**
 * The stages a stream may be put on: those the manager has not retired, on an
 * engine the admin takes streams on. The API refuses any other with
 * `stage_unavailable`, so the picker does not offer them.
 *
 * `recordingOwner` is the owner of a draft older than stages that holds a
 * recording and no stage. Its recording is signed as that address, which it
 * keeps, so it may be given only a stage that signs as the same; the API
 * refuses any other with `stage_locked`.
 */
export function assignableStages(
  stages: readonly StageSummary[],
  recordingOwner: string | null = null,
): StageSummary[] {
  return stages.filter(
    (stage) =>
      stage.retiredAt === null &&
      stage.supported &&
      (recordingOwner === null || sameFeedOwner(stage.owner, recordingOwner)),
  );
}

/** Said when no stage signs as the owner of a recording older than stages. */
export const NO_STAGE_FOR_RECORDING =
  "No stage signs as this recording's owner, so none can take it. A stage signs as the key its deployment was given in the manager.";

/** How the picker and My Streams name a stage the list does not hold: its id, shortened. */
export function unknownStageLabel(stageId: string): string {
  return `Unknown stage ${shortHex(stageId, 8, 4)}`;
}

/** Why a stage in the list takes no new streams, for the option that still has to show it. */
function unavailableNote(stage: StageSummary): string | null {
  if (stage.retiredAt) return 'retired';
  if (!stage.supported) return 'not supported';
  return null;
}

/**
 * The stream form's stage picker. A native select, like the thumbnail input,
 * so it stays plain on a phone and in the tests. `value` is a stage id, or ''
 * for none. It offers the stages a stream may be put on, and the stream's own
 * stage beside them when that one takes no new streams any more, so the field
 * still says where the stream is.
 */
export function StageField({
  value,
  onChange,
  stages,
  loadError = null,
  disabled = false,
  helperText,
  recordingOwner = null,
}: {
  value: string;
  onChange: (stageId: string) => void;
  /** Null while the list is loading. */
  stages: readonly StageSummary[] | null;
  loadError?: string | null;
  disabled?: boolean;
  helperText?: string;
  /** The owner of a recording older than stages, which only a stage signing as it may take. */
  recordingOwner?: string | null;
}) {
  const offered = assignableStages(stages ?? [], recordingOwner);
  const current = value && !offered.some((stage) => stage.stageId === value) ? value : null;
  const currentStage = current ? (stages ?? []).find((stage) => stage.stageId === current) : undefined;

  let help = helperText;
  if (!help && loadError) help = loadError;
  if (!help && stages !== null && offered.length === 0) {
    help = recordingOwner
      ? NO_STAGE_FOR_RECORDING
      : 'No stage takes streams yet. The manager registers each one once its admin link points here.';
  }

  return (
    <TextField
      id="stream-stage"
      label="Stage"
      select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || stages === null}
      helperText={help}
      error={Boolean(loadError) && !helperText}
      fullWidth
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
    >
      <option value="">No stage</option>
      {offered.map((stage) => (
        <option key={stage.stageId} value={stage.stageId}>
          {stage.name}
        </option>
      ))}
      {current ? (
        <option value={current} disabled>
          {currentStage
            ? `${currentStage.name} (${unavailableNote(currentStage) ?? 'unavailable'})`
            : unknownStageLabel(current)}
        </option>
      ) : null}
    </TextField>
  );
}

/**
 * Said before a stream is scheduled on a stage the manager does not call
 * ready: its verdict, its reasons and when it last confirmed them. A warning,
 * not a block. The manager works readiness out, and it can be right again by
 * the time the stream starts.
 */
export function StageReadinessWarning({ stage, now = Date.now() }: { stage: StageSummary; now?: number }) {
  const notes: string[] = [];
  if (stage.retiredAt)
    notes.push('The manager retired this stage, so it takes no new streams. A stream on it keeps it.');
  if (!stage.supported) notes.push('The admin does not take streams on this engine yet.');
  const ready = stage.readiness.tone === 'ready';
  if (ready && notes.length === 0) return null;

  return (
    <Alert severity="warning">
      {ready ? null : (
        <Box>
          {stage.name} is{' '}
          {stage.readiness.tone === 'unknown' ? 'of unknown readiness' : `not ready (${stage.readiness.tone})`}
          {stage.readiness.reasons.length > 0 ? `: ${stage.readiness.reasons.join('; ')}` : ''}. The manager last
          confirmed it {formatAgo(stage.observedAt, now)}.
        </Box>
      )}
      {notes.map((note) => (
        <Box key={note}>{note}</Box>
      ))}
    </Alert>
  );
}
