import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOST_RECORDINGS_REMOVAL_CONFIRM,
  type CheckedRecording,
  type LostRecordingsRemovalResponse,
  type RecordingCheck,
  type RecordingCheckResponse,
} from '@streaming-monorepo/web2-admin-common';

import {
  ALL_READ,
  CHECK_INTRO,
  checkReadFailed,
  KEPT_AS_DRAFT,
  PARTLY_LOST_NOTE,
  RECORDING_CHECK_POLL_MS,
  RECORDING_MARK,
  removalFailed,
  removalLines,
  removalTitle,
  runningText,
  unjudgedText,
} from '../components/recordings/RecordingCheckPanel';
import { StreamsPage } from '../pages/StreamsPage';
import { jsonError, jsonOk, makeStream, mockFetch, renderWithProviders } from './helpers';

const STREAMS = '/api/streams';
const CHECK = '/api/recordings/check';
const REMOVAL = '/api/recordings/lost/removal';

function recording(over: Partial<CheckedRecording> = {}): CheckedRecording {
  return {
    streamId: 'st-lost',
    title: 'Gone concert',
    status: 'vod',
    verdict: 'lost',
    failedQualities: ['360p', '720p'],
    hasExportFile: false,
    ...over,
  };
}

function makeCheck(over: Partial<RecordingCheck> = {}): RecordingCheck {
  return {
    id: 'check-1',
    state: 'done',
    stopMessage: null,
    round: 3,
    nextRoundAt: null,
    total: 6,
    readThisRound: 2,
    unjudged: 0,
    lost: [],
    partlyLost: [],
    startedBy: 'admin',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T10:20:00.000Z',
    ...over,
  };
}

const LOST = [
  recording(),
  recording({ streamId: 'st-kept', title: 'Exported talk', hasExportFile: true, failedQualities: [] }),
];
const PARTLY = [
  recording({ streamId: 'st-partly', title: 'Half there', verdict: 'partly_lost', failedQualities: ['1080p'] }),
];

interface Serve {
  check?: () => RecordingCheckResponse | Response;
  removal?: () => Response;
}

function serve({ check = () => ({ check: null, startRefusal: null, removalRefusal: null }), removal }: Serve = {}) {
  return mockFetch([
    {
      path: STREAMS,
      respond: () =>
        jsonOk({
          streams: [
            makeStream({ id: 'st-lost', title: 'Gone concert', status: 'vod', recording: 'lost' }),
            makeStream({
              id: 'st-partly',
              title: 'Half there',
              status: 'vod',
              recording: 'partly_lost',
              recordingCheckedAt: '2026-11-19T10:20:00.000Z',
            }),
            makeStream({ id: 'st-fine', title: 'Fine show', status: 'vod' }),
          ],
        }),
    },
    {
      path: CHECK,
      respond: () => {
        const answer = check();
        return 'check' in answer ? jsonOk(answer) : answer;
      },
    },
    { path: CHECK, method: 'POST', respond: () => jsonOk(makeCheck({ state: 'running', round: 1 }), 202) },
    {
      path: REMOVAL,
      method: 'POST',
      respond: () =>
        removal
          ? removal()
          : jsonOk({
              removed: [{ streamId: 'st-lost', title: 'Gone concert' }],
              unlisted: [{ streamId: 'st-kept', title: 'Exported talk' }],
              kept: [],
              feedIndex: 12,
            } satisfies LostRecordingsRemovalResponse),
    },
  ]);
}

const callsTo = (fetchMock: ReturnType<typeof mockFetch>, path: string, method = 'GET') =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET').toUpperCase() === method,
  );

async function openStreams() {
  renderWithProviders(<StreamsPage />);
  await screen.findByText('Fine show');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('checking the recordings on the Streams page', () => {
  it('shows nothing of checks when the admin does not answer them', async () => {
    serve({ check: () => jsonError(404, { error: 'not_found' }) });
    await openStreams();
    expect(screen.queryByRole('button', { name: 'Check recordings' })).not.toBeInTheDocument();
  });

  it('starts a check, which a person does, and reads it again', async () => {
    const fetchMock = serve();
    await openStreams();
    expect(await screen.findByText(CHECK_INTRO)).toBeInTheDocument();
    const reads = callsTo(fetchMock, CHECK).length;
    fireEvent.click(screen.getByRole('button', { name: 'Check recordings' }));
    await waitFor(() => expect(callsTo(fetchMock, CHECK, 'POST')).toHaveLength(1));
    await waitFor(() => expect(callsTo(fetchMock, CHECK).length).toBeGreaterThan(reads));
  });

  it('says why a check cannot start now', async () => {
    const why = 'The catalogue node has 2 peers, and a check needs 4.';
    serve({ check: () => ({ check: null, startRefusal: why, removalRefusal: null }) });
    await openStreams();
    expect(await screen.findByText(why)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check recordings' })).toBeDisabled();
  });

  it('shows a running check, reads it again while it runs, and the streams once it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = makeCheck({
      state: 'running',
      round: 2,
      readThisRound: 1,
      total: 4,
      nextRoundAt: '2026-11-19T10:20:00.000Z',
      finishedAt: null,
    });
    let answer: RecordingCheckResponse = {
      check: running,
      startRefusal: 'A check is running.',
      removalRefusal: 'The check is not done.',
    };
    const fetchMock = serve({ check: () => answer });
    await openStreams();
    expect(await screen.findByText(runningText(running))).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Check progress' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.queryByText('A check is running.')).not.toBeInTheDocument();
    const lists = callsTo(fetchMock, STREAMS).length;

    answer = { check: makeCheck({ lost: [LOST[0]] }), startRefusal: null, removalRefusal: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORDING_CHECK_POLL_MS);
    });
    expect(await screen.findByText('1 recording lost')).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, STREAMS).length).toBeGreaterThan(lists));
  });

  it('says why a check stopped with no result', async () => {
    serve({
      check: () => ({
        check: makeCheck({ state: 'stopped', stopMessage: 'The catalogue node fell under 4 peers.' }),
        startRefusal: null,
        removalRefusal: null,
      }),
    });
    await openStreams();
    expect(
      await screen.findByText('The check stopped with no result: The catalogue node fell under 4 peers.'),
    ).toBeInTheDocument();
  });

  it('lists the lost and the partly lost, each a link to its stream, and marks their rows', async () => {
    serve({
      check: () => ({
        check: makeCheck({ lost: LOST, partlyLost: PARTLY, unjudged: 3 }),
        startRefusal: null,
        removalRefusal: null,
      }),
    });
    await openStreams();
    expect(await screen.findByText('2 recordings lost')).toBeInTheDocument();
    const lost = within(screen.getByRole('list', { name: 'Lost recordings' }));
    expect(lost.getByRole('link', { name: 'Gone concert' })).toHaveAttribute('href', '/streams/st-lost');
    expect(lost.getByText(KEPT_AS_DRAFT)).toBeInTheDocument();
    expect(screen.getByText('1 partly lost')).toBeInTheDocument();
    const partly = within(screen.getByRole('list', { name: 'Partly lost recordings' }));
    expect(partly.getByRole('link', { name: 'Half there' })).toHaveAttribute('href', '/streams/st-partly');
    expect(partly.getByText(': 1080p could not be read')).toBeInTheDocument();
    expect(screen.getByText(PARTLY_LOST_NOTE)).toBeInTheDocument();
    expect(screen.getByText(unjudgedText(3))).toBeInTheDocument();

    const table = within(screen.getByRole('table'));
    const row = (title: string) => within(table.getByText(title).closest('tr') as HTMLElement);
    expect(row('Gone concert').getByText(RECORDING_MARK.lost)).toBeInTheDocument();
    expect(row('Half there').getByText(RECORDING_MARK.partly_lost)).toBeInTheDocument();
    expect(row('Fine show').queryByText(RECORDING_MARK.lost)).not.toBeInTheDocument();
  });

  it('says every recording could be read, and offers no removal', async () => {
    serve({ check: () => ({ check: makeCheck(), startRefusal: null, removalRefusal: null }) });
    await openStreams();
    expect(await screen.findByText(ALL_READ)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove lost recordings' })).not.toBeInTheDocument();
  });

  it('removes the lost recordings after a confirm that lists them, and says what it did', async () => {
    const fetchMock = serve({
      check: () => ({ check: makeCheck({ lost: LOST, partlyLost: PARTLY }), startRefusal: null, removalRefusal: null }),
    });
    await openStreams();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove lost recordings' }));

    const confirm = within(screen.getByRole('dialog', { name: removalTitle(2) }));
    expect(confirm.getByText(LOST_RECORDINGS_REMOVAL_CONFIRM)).toBeInTheDocument();
    const listed = within(confirm.getByRole('list', { name: 'Recordings to remove' }));
    expect(listed.getByText('Gone concert')).toBeInTheDocument();
    expect(listed.getByText('Exported talk (kept as a draft)')).toBeInTheDocument();
    expect(listed.queryByText(/Half there/)).not.toBeInTheDocument();
    const lists = callsTo(fetchMock, STREAMS).length;
    fireEvent.click(confirm.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(callsTo(fetchMock, REMOVAL, 'POST')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, REMOVAL, 'POST')[0][1]?.body))).toEqual({
      checkId: 'check-1',
      streamIds: ['st-lost', 'st-kept'],
    });
    expect(await screen.findByText('Removed: “Gone concert”.')).toBeInTheDocument();
    expect(screen.getByText('Kept as drafts off the catalogue: “Exported talk”.')).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, STREAMS).length).toBeGreaterThan(lists));
  });

  it('reads the check again after a refused removal, so Remove follows what the admin says now', async () => {
    const message = 'The catalogue batch has run out. Buy a new catalogue batch on the Funding page first.';
    let refusal: string | null = null;
    const fetchMock = serve({
      check: () => ({ check: makeCheck({ lost: LOST }), startRefusal: null, removalRefusal: refusal }),
      removal: () => {
        refusal = message;
        return jsonError(409, { error: 'recordings_refused', message });
      },
    });
    await openStreams();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove lost recordings' }));
    const reads = callsTo(fetchMock, CHECK).length;
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(callsTo(fetchMock, CHECK).length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove lost recordings' })).toBeDisabled());
    expect(screen.getByText(removalFailed(message))).toBeInTheDocument();
  });

  it('keeps the check and says so when a read of it fails, and goes on reading it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = makeCheck({ state: 'running', round: 1, readThisRound: 1, total: 4, finishedAt: null });
    let answer: RecordingCheckResponse | Response = {
      check: running,
      startRefusal: 'A check is running.',
      removalRefusal: null,
    };
    serve({ check: () => answer });
    await openStreams();
    expect(await screen.findByText(runningText(running))).toBeInTheDocument();

    answer = jsonError(502, { error: 'bad_gateway', message: 'The admin did not answer.' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORDING_CHECK_POLL_MS);
    });
    expect(await screen.findByText(checkReadFailed('The admin did not answer.'))).toBeInTheDocument();
    expect(screen.getByText(runningText(running))).toBeInTheDocument();

    answer = { check: makeCheck({ lost: [LOST[0]] }), startRefusal: null, removalRefusal: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORDING_CHECK_POLL_MS);
    });
    expect(await screen.findByText('1 recording lost')).toBeInTheDocument();
    expect(screen.queryByText(checkReadFailed('The admin did not answer.'))).not.toBeInTheDocument();
  });

  it('says why the lost recordings cannot be removed now', async () => {
    const why = 'This check ended more than six hours ago. Run a new check first.';
    serve({ check: () => ({ check: makeCheck({ lost: LOST }), startRefusal: null, removalRefusal: why }) });
    await openStreams();
    expect(await screen.findByText(why)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove lost recordings' })).toBeDisabled();
  });

  it('names only the reasons a check leaves a stream unjudged now, and no test streams', () => {
    expect(unjudgedText(2)).toBe(
      '2 streams were left unjudged: live, inside the restart window, or with an export or an archive under way.',
    );
    expect(unjudgedText(1)).not.toMatch(/test/);
  });

  it('says what a removal kept and why', () => {
    expect(
      removalLines({
        removed: [],
        unlisted: [],
        kept: [{ streamId: 'a', title: 'Back again', reason: 'It is live now.' }],
        feedIndex: null,
      }),
    ).toEqual(['Left as it is: “Back again”. It is live now.']);
    expect(removalLines({ removed: [], unlisted: [], kept: [], feedIndex: null })).toEqual(['Nothing was removed.']);
  });
});
