import { useEffect, useState } from 'react';
import { Alert, Chip, Stack, Tooltip } from '@mui/material';
import { isTestLeftRunning, type Stream } from '@streaming-monorepo/web2-admin-common';

import { formatTimeLeft } from '../../format';

/** The mark a test stream carries wherever the console lists or shows it. */
export const TEST_MARK = 'Test';

/** Beside a test that has been live for more than `TEST_STREAM_LEFT_RUNNING_SECONDS`. */
export const LEFT_RUNNING = 'Left running';

/** What the "Left running" mark says on hover. The admin stops no broadcast. */
export const LEFT_RUNNING_HINT =
  'This test has been live for more than an hour, spending its stage’s stamps. A broadcast is stopped at the ' +
  'encoder or from the manager.';

/** How often the time a test has been live is worked out again. */
const LIVE_CLOCK_TICK_MS = 30_000;

/** The time now, read again every 30 seconds while `ticking`, for a test's time live. */
export function useLiveClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), LIVE_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

export function TestMark() {
  return <Chip size="small" variant="outlined" color="secondary" label={TEST_MARK} />;
}

/** Whether a stream is a test that is live now. */
export function isLiveTest(stream: Stream): boolean {
  return stream.test && stream.status === 'live';
}

/**
 * "Test live" with how long the test has been live, and "Left running" once that is more than an hour. Nothing for a
 * stream that is no live test.
 */
export function TestLiveMark({ stream, now }: { stream: Stream; now: number }) {
  if (!isLiveTest(stream) || !stream.liveSince) return null;
  const seconds = Math.max(0, (now - Date.parse(stream.liveSince)) / 1000);
  const leftRunning = isTestLeftRunning(stream, new Date(now));
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Chip
        size="small"
        variant="outlined"
        color={leftRunning ? 'warning' : 'info'}
        label={`Test live · ${formatTimeLeft(seconds)}`}
      />
      {leftRunning ? (
        <Tooltip title={LEFT_RUNNING_HINT}>
          <Chip size="small" color="warning" label={LEFT_RUNNING} />
        </Tooltip>
      ) : null}
    </Stack>
  );
}

/** The streams live on a stage, but for the one named. */
export function liveOnStage(streams: readonly Stream[], stageId: string, exceptId: string): Stream[] {
  return streams.filter((other) => other.id !== exceptId && other.stageId === stageId && other.status === 'live');
}

function quoted(streams: readonly Stream[]): string {
  return streams.map((other) => `“${other.title}”`).join(', ');
}

/**
 * What shares the stream's stage now, from the streams the console read: on a test's page, the other streams live on
 * its stage; on any other stream's page, the tests live on its stage. Information only: a stage takes several
 * broadcasts at once, and the two share its transcoding and upload.
 */
export function sharedStageNote(stream: Stream, streams: readonly Stream[]): string | null {
  if (!stream.stageId) return null;
  const live = liveOnStage(streams, stream.stageId, stream.id);
  const shown = stream.test ? live : live.filter((other) => other.test);
  if (shown.length === 0) return null;
  const share = 'They share the stage’s transcoding and upload while both are live.';
  if (stream.test) {
    return shown.length === 1
      ? `Another stream is live on this stage: ${quoted(shown)}. ${share}`
      : `Other streams are live on this stage: ${quoted(shown)}. ${share}`;
  }
  return shown.length === 1
    ? `A test stream is live on this stage: ${quoted(shown)}. ${share}`
    : `Test streams are live on this stage: ${quoted(shown)}. ${share}`;
}

export function SharedStageNote({ stream, streams }: { stream: Stream; streams: readonly Stream[] | null }) {
  const note = streams ? sharedStageNote(stream, streams) : null;
  return note ? <Alert severity="info">{note}</Alert> : null;
}

/**
 * The new test stream form, with the stage of `stream` filled in: "Test this setup". The form offers no media type,
 * as the stream form offers none, so an older audio stream's type is not carried there.
 */
export function testSetupPath(stream: Pick<Stream, 'stageId'>): string {
  const params = new URLSearchParams({ test: '1' });
  if (stream.stageId) params.set('stageId', stream.stageId);
  return `/create?${params.toString()}`;
}

/** The new test stream form, with nothing filled in. */
export const NEW_TEST_STREAM_PATH = '/create?test=1';
