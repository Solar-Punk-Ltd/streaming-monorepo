import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { Alert, Button, Chip, LinearProgress, Link, Paper, Stack, Tooltip, Typography } from '@mui/material';
import {
  LOST_RECORDINGS_REMOVAL_CONFIRM,
  RECORDING_CHECK_ROUNDS,
  type CheckedRecording,
  type LostRecordingsRemovalResponse,
  type RecordingCheck,
  type RecordingCheckResponse,
  type Stream,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatDateTime } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { ConfirmDialog } from '../ConfirmDialog';

/**
 * Checking the recordings on the Streams page and removing the lost ones: `docs/architecture/web2-admin.md`, "Lost
 * recordings", is the design, and the common `lostRecordings.ts` the contract. A person starts a check; nothing runs it
 * in the background.
 */

/** How often the page reads a running check again. */
export const RECORDING_CHECK_POLL_MS = 15_000;

/** Said before the first check, under Check recordings: what a check does. */
export const CHECK_INTRO =
  'A check reads every finished recording from Swarm through the catalogue node, three times over twenty minutes, and lists the ones that are gone.';

/** Said under a check that left streams unjudged. */
export function unjudgedText(count: number): string {
  const streams = count === 1 ? 'One stream was' : `${count} streams were`;
  return `${streams} left unjudged: live, inside the restart window, with an export or an archive under way, or a test stream.`;
}

/** `N recordings lost`, the line a finished check leads with. */
export function lostCount(count: number): string {
  return `${count} recording${count === 1 ? '' : 's'} lost`;
}

/** `N partly lost`. */
export function partlyLostCount(count: number): string {
  return `${count} partly lost`;
}

/** The title of the removal's confirm. */
export function removalTitle(count: number): string {
  return `Remove ${count} lost recording${count === 1 ? '' : 's'}?`;
}

/** Said when a finished check could read every recording it judged. */
export const ALL_READ = 'Every recording the check judged could be read.';

/** Said under the partly lost recordings: they are listed, and the removal leaves them alone. */
export const PARTLY_LOST_NOTE = 'A partly lost recording still plays in some quality. It is listed and left as it is.';

/** Said under a lost recording whose export file the server keeps. */
export const KEPT_AS_DRAFT = 'Its export file is on the server, so it is kept as a draft off the catalogue.';

/** The stream list's mark of what the latest check found of a recording. */
export const RECORDING_MARK = {
  lost: 'Lost on Swarm',
  partly_lost: 'Partly lost',
} as const;

/** Said over the check shown when it could not be read again, with why. */
export function checkReadFailed(error: string): string {
  return `The check could not be read again: ${error}`;
}

/** Said in the panel when a removal was refused, with the admin's sentence. */
export function removalFailed(error: string): string {
  return `Nothing was removed: ${error}`;
}

/** Where a running check stands, in a sentence. */
export function runningText(check: RecordingCheck): string {
  return `Checking the recordings: round ${check.round} of ${RECORDING_CHECK_ROUNDS}, ${check.readThisRound} of ${check.total} read.`;
}

/** What a removal did, a sentence each, for the alert after it. */
export function removalLines(answer: LostRecordingsRemovalResponse): string[] {
  const titles = (list: { title: string }[]) => list.map((stream) => `“${stream.title}”`).join(', ');
  const lines: string[] = [];
  if (answer.removed.length > 0) lines.push(`Removed: ${titles(answer.removed)}.`);
  if (answer.unlisted.length > 0) lines.push(`Kept as drafts off the catalogue: ${titles(answer.unlisted)}.`);
  for (const kept of answer.kept) lines.push(`Left as it is: “${kept.title}”. ${kept.reason}`);
  if (lines.length === 0) lines.push('Nothing was removed.');
  return lines;
}

/** The mark a stream's row carries from the latest check: lost or partly lost, with when that check ended on hover. */
export function RecordingMark({ stream }: { stream: Pick<Stream, 'recording' | 'recordingCheckedAt'> }) {
  if (!stream.recording) return null;
  const chip = (
    <Chip
      size="small"
      variant="outlined"
      color={stream.recording === 'lost' ? 'error' : 'warning'}
      label={RECORDING_MARK[stream.recording]}
    />
  );
  if (!stream.recordingCheckedAt) return chip;
  return (
    <Tooltip title={`Found by the check that ended ${formatDateTime(stream.recordingCheckedAt)}.`}>{chip}</Tooltip>
  );
}

/**
 * The latest check as the admin answers it, read once and again every {@link RECORDING_CHECK_POLL_MS} while it runs.
 * Null until it is first read, so an admin that has no checks shows nothing of them. A read that fails after that
 * keeps the check last read, and its timer, and `error` says why until a read answers again. `onFinished` is called
 * when a running check is read as ended, so the page marks the rows.
 */
function useRecordingCheck(onFinished: () => void) {
  const [answer, setAnswer] = useState<RecordingCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const wasRunning = useRef(false);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  const read = useCallback(async (background: boolean) => {
    try {
      const next = await api.fetchRecordingCheck({ background });
      const running = next.check?.state === 'running';
      if (wasRunning.current && !running) finished.current();
      wasRunning.current = running;
      setAnswer(next);
      setError(null);
    } catch (e: unknown) {
      setError(errorMessage(e, 'The check could not be read.'));
    }
  }, []);

  useEffect(() => {
    void read(false);
  }, [read, tick]);

  const running = answer?.check?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void read(true), RECORDING_CHECK_POLL_MS);
    return () => clearInterval(timer);
  }, [running, read]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { answer, error, reload };
}

function RecordingItem({ recording }: { recording: CheckedRecording }) {
  return (
    <li>
      <Link component={RouterLink} to={`/streams/${recording.streamId}`} variant="body2">
        {recording.title}
      </Link>
      {recording.verdict === 'partly_lost' && recording.failedQualities.length > 0 ? (
        <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
          {`: ${recording.failedQualities.join(', ')} could not be read`}
        </Typography>
      ) : null}
      {recording.verdict === 'lost' && recording.hasExportFile ? (
        <Typography variant="caption" component="div" sx={{ color: 'text.secondary' }}>
          {KEPT_AS_DRAFT}
        </Typography>
      ) : null}
    </li>
  );
}

/** A finished check's result: the lost recordings, the partly lost, or that every one could be read. */
function CheckResult({ check }: { check: RecordingCheck }) {
  return (
    <Stack spacing={1}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {`Started by ${check.startedBy}, ended ${formatDateTime(check.finishedAt)}.`}
      </Typography>
      {check.lost.length === 0 && check.partlyLost.length === 0 ? (
        <Typography variant="body2">{ALL_READ}</Typography>
      ) : null}
      {check.lost.length > 0 ? (
        <Stack spacing={0.5}>
          <Typography variant="body2" sx={{ fontWeight: 600, color: 'error.main' }}>
            {lostCount(check.lost.length)}
          </Typography>
          <Stack component="ul" aria-label="Lost recordings" sx={{ m: 0, pl: 2.5 }}>
            {check.lost.map((recording) => (
              <RecordingItem key={recording.streamId} recording={recording} />
            ))}
          </Stack>
        </Stack>
      ) : null}
      {check.partlyLost.length > 0 ? (
        <Stack spacing={0.5}>
          <Typography variant="body2" sx={{ fontWeight: 600, color: 'warning.main' }}>
            {partlyLostCount(check.partlyLost.length)}
          </Typography>
          <Stack component="ul" aria-label="Partly lost recordings" sx={{ m: 0, pl: 2.5 }}>
            {check.partlyLost.map((recording) => (
              <RecordingItem key={recording.streamId} recording={recording} />
            ))}
          </Stack>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {PARTLY_LOST_NOTE}
          </Typography>
        </Stack>
      ) : null}
    </Stack>
  );
}

/**
 * The Streams page's check of the recordings: Check recordings, which a person starts, or why it cannot start now; a
 * running check's round and progress; a stopped one's reason; and a finished one's result, "N recordings lost" and the
 * partly lost, each a link to its stream. Remove lost recordings, or why it cannot be used now, asks first, listing
 * every recording it removes and which are kept as drafts for their export file, then sends that list, and says what
 * was removed, kept as a draft or left. A refused removal closes the confirm, says why, and reads the check again, so
 * Remove follows what the admin says now. `onChanged` reads the stream list again, after a check ends or a removal.
 */
export function RecordingCheckPanel({ onChanged }: { onChanged: () => void }) {
  const { answer, error: readError, reload } = useRecordingCheck(onChanged);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<LostRecordingsRemovalResponse | null>(null);

  if (!answer) return null;
  const { check, startRefusal, removalRefusal } = answer;

  const start = async () => {
    setStarting(true);
    setStartError(null);
    setRemoved(null);
    try {
      await api.startRecordingCheck();
    } catch (e: unknown) {
      setStartError(errorMessage(e, 'The check could not be started.'));
    } finally {
      setStarting(false);
      reload();
    }
  };

  const remove = async (current: RecordingCheck) => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await api.removeLostRecordings(
        current.id,
        current.lost.map((recording) => recording.streamId),
      );
      setRemoved(result);
      setConfirming(false);
      onChanged();
      reload();
    } catch (e: unknown) {
      // The check is read again, so Remove follows what the admin says of it now, and the confirm closes on it.
      setRemoveError(errorMessage(e, 'The lost recordings could not be removed.'));
      setConfirming(false);
      reload();
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
          <Typography variant="subtitle1" component="h2" sx={{ flexGrow: 1 }}>
            Recordings on Swarm
          </Typography>
          <Button variant="outlined" disabled={starting || startRefusal !== null} onClick={() => void start()}>
            Check recordings
          </Button>
        </Stack>
        {startRefusal && check?.state !== 'running' ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {startRefusal}
          </Typography>
        ) : null}
        {!check ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {CHECK_INTRO}
          </Typography>
        ) : null}
        {readError ? <Alert severity="warning">{checkReadFailed(readError)}</Alert> : null}
        {startError ? <Alert severity="error">{startError}</Alert> : null}

        {check?.state === 'running' ? (
          <Stack spacing={1}>
            <Typography variant="body2">{runningText(check)}</Typography>
            <LinearProgress
              aria-label="Check progress"
              variant={check.total > 0 ? 'determinate' : 'indeterminate'}
              value={check.total > 0 ? Math.min(100, (100 * check.readThisRound) / check.total) : undefined}
            />
            {check.nextRoundAt ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {`The recordings that failed are read again at ${formatDateTime(check.nextRoundAt)}.`}
              </Typography>
            ) : null}
          </Stack>
        ) : null}

        {check?.state === 'stopped' ? (
          <Alert severity="warning">{`The check stopped with no result: ${check.stopMessage ?? 'no reason was given.'}`}</Alert>
        ) : null}

        {check?.state === 'done' ? <CheckResult check={check} /> : null}

        {check?.state === 'done' && check.lost.length > 0 ? (
          <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
            <Button
              variant="contained"
              color="error"
              disabled={removalRefusal !== null}
              onClick={() => {
                setRemoveError(null);
                setConfirming(true);
              }}
            >
              Remove lost recordings
            </Button>
            {removalRefusal ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {removalRefusal}
              </Typography>
            ) : null}
          </Stack>
        ) : null}
        {removeError ? (
          <Alert severity="error" onClose={() => setRemoveError(null)}>
            {removalFailed(removeError)}
          </Alert>
        ) : null}

        {check && check.unjudged > 0 ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {unjudgedText(check.unjudged)}
          </Typography>
        ) : null}

        {removed ? (
          <Alert severity="success" onClose={() => setRemoved(null)}>
            <Stack spacing={0.5}>
              {removalLines(removed).map((line) => (
                <Typography key={line} variant="body2">
                  {line}
                </Typography>
              ))}
            </Stack>
          </Alert>
        ) : null}
      </Stack>

      {check?.state === 'done' ? (
        <ConfirmDialog
          open={confirming}
          title={removalTitle(check.lost.length)}
          message={
            <Stack spacing={1.5}>
              <span>{LOST_RECORDINGS_REMOVAL_CONFIRM}</span>
              <Stack component="ul" aria-label="Recordings to remove" sx={{ m: 0, pl: 2.5 }}>
                {check.lost.map((recording) => (
                  <li key={recording.streamId}>
                    {recording.title}
                    {recording.hasExportFile ? ' (kept as a draft)' : ''}
                  </li>
                ))}
              </Stack>
            </Stack>
          }
          confirmText={removing ? 'Removing…' : 'Remove'}
          busy={removing}
          onConfirm={() => void remove(check)}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </Paper>
  );
}
