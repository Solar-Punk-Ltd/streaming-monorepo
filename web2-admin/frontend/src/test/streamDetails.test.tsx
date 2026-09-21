import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type {
  OwnerLegacyAdoptionOperation,
  OwnerContinuationOperation,
  Stream,
} from '@streaming-monorepo/web2-admin-common';

import { StreamDetailsPage } from '../pages/StreamDetailsPage';
import { ContinuationPanel } from '../components/ContinuationPanel';
import {
  jsonOk,
  jsonError,
  makeIngest,
  makeStream,
  mockFetch,
  type Route as MockRoute,
  renderWithProviders,
} from './helpers';

const ID = 'stream-under-test';

const EDITED_SINCE_PUBLISH =
  'Edited since it was published. Republish to update the feed.';

function routesFor(stream: Stream, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: `/api/streams/${ID}`, respond: () => jsonOk(stream) },
    { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest()) },
    {
      path: '/api/config',
      respond: () =>
        jsonOk({
          feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff' },
          viewerBaseUrl: null,
        }),
    },
  ];
}

function renderDetails() {
  return renderWithProviders(
    <Routes>
      <Route path="/streams/:id" element={<StreamDetailsPage />} />
    </Routes>,
    { route: `/streams/${ID}` },
  );
}

function managedVod(): Stream {
  return makeStream({
    id: ID,
    status: 'vod',
    lifecycle: {
      version: 1,
      revision: 5,
      runNumber: 1,
      state: 'vod',
      permission: 'closed',
      canContinue: true,
    },
    completedRecording: {
      runNumber: 1,
      master: {
        topic: '11111111-1111-4111-8111-111111111111',
        index: 32,
        reference: 'fixture-master-reference',
        duration: 724.5,
      },
      expectedRenditions: [],
      renditions: [],
    },
  });
}

function pendingOperation(
  operationId = '88888888-8888-4888-8888-888888888888',
): OwnerContinuationOperation {
  return {
    lifecycleVersion: 1,
    operationId,
    requestId: '77777777-7777-4777-8777-777777777777',
    streamId: ID,
    topic: '11111111-1111-4111-8111-111111111111',
    mediaType: 'video',
    previousRunNumber: 1,
    nextRunNumber: 2,
    revision: 6,
    status: 'pending',
  };
}

function legacyVod(): Stream {
  return makeStream({
    id: ID,
    status: 'vod',
    manifestIndex: 12,
    durationSeconds: 62.5,
  });
}

function pendingLegacyPreparation(): OwnerLegacyAdoptionOperation {
  return {
    lifecycleVersion: 1,
    kind: 'legacy-adoption',
    operationId: '99999999-9999-4999-8999-999999999999',
    requestId: '77777777-7777-4777-8777-777777777777',
    streamId: ID,
    topic: '11111111-1111-4111-8111-111111111111',
    mediaType: 'video',
    candidateDigest: 'a'.repeat(64),
    revision: 1,
    status: 'pending',
  };
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

describe('StreamDetailsPage', () => {
  it('reuses one request while preparing an existing recording to continue', async () => {
    const requests: Array<{
      requestId: string;
      expectedCandidateDigest: string;
    }> = [];
    mockFetch(
      routesFor(legacyVod(), [
        {
          path: `/api/streams/${ID}/legacy-adoptions/candidate`,
          respond: () => jsonOk({ candidateDigest: 'a'.repeat(64) }),
        },
        {
          method: 'POST',
          path: `/api/streams/${ID}/legacy-adoptions`,
          respond: (init) => {
            if (typeof init?.body !== 'string') {
              throw new TypeError('expected a JSON request body');
            }
            requests.push(JSON.parse(init.body) as (typeof requests)[number]);
            return requests.length === 1
              ? Promise.reject(new TypeError('response lost'))
              : jsonOk(
                  {
                    operation: {
                      ...pendingLegacyPreparation(),
                      requestId: requests[1].requestId,
                    },
                  },
                  202,
                );
          },
        },
      ]),
    );

    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Prepare to continue' }),
    );

    expect(
      await screen.findByText('Checking the previous recording.'),
    ).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(
      screen.getByText(
        'Your existing replay stays available while this one-time check runs.',
      ),
    ).toBeInTheDocument();
  });

  it('recovers pending and failed recording preparation after reload', async () => {
    const pending = legacyVod();
    pending.legacyAdoption = pendingLegacyPreparation();

    mockFetch(routesFor(pending));
    const page = renderDetails();
    expect(
      await screen.findByText('Checking the previous recording.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel preparation' }),
    ).toBeEnabled();
    page.unmount();

    const failed = legacyVod();
    failed.legacyAdoption = {
      ...pendingLegacyPreparation(),
      revision: 2,
      status: 'failed',
      failure: 'The 720p recording is missing from storage.',
    };
    mockFetch(routesFor(failed));
    renderDetails();
    expect(
      await screen.findByText('The 720p recording is missing from storage.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try preparation again' }),
    ).toBeEnabled();
  });

  it('replaces a failed preparation with a new lower-revision attempt', async () => {
    const failed = legacyVod();
    failed.legacyAdoption = {
      ...pendingLegacyPreparation(),
      revision: 2,
      status: 'failed',
      failure: 'The previous recording could not be read.',
    };
    const retriedOperation = {
      ...pendingLegacyPreparation(),
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      revision: 1,
    };
    const retried = legacyVod();
    let retryRequestId = retriedOperation.requestId;
    let reads = 0;
    mockFetch(
      routesFor(failed, [
        {
          path: `/api/streams/${ID}`,
          respond: () => {
            retried.legacyAdoption = {
              ...retriedOperation,
              requestId: retryRequestId,
            };
            return jsonOk(reads++ === 0 ? failed : retried);
          },
        },
        {
          path: `/api/streams/${ID}/legacy-adoptions/candidate`,
          respond: () => jsonOk({ candidateDigest: 'a'.repeat(64) }),
        },
        {
          method: 'POST',
          path: `/api/streams/${ID}/legacy-adoptions`,
          respond: (init) => {
            if (typeof init?.body !== 'string') {
              throw new TypeError('expected a JSON request body');
            }
            const request = JSON.parse(init.body) as { requestId: string };
            retryRequestId = request.requestId;
            return jsonOk({
              operation: { ...retriedOperation, requestId: retryRequestId },
            });
          },
        },
      ]),
    );

    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Try preparation again' }),
    );

    expect(
      await screen.findByText('Checking the previous recording.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel preparation' }),
    ).toBeEnabled();
    expect(
      screen.queryByText('The previous recording could not be read.'),
    ).not.toBeInTheDocument();
  });

  it('ignores an old operation refresh after a newer operation arrives', async () => {
    const old = legacyVod();
    old.legacyAdoption = pendingLegacyPreparation();
    const current = legacyVod();
    current.legacyAdoption = {
      ...pendingLegacyPreparation(),
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      revision: 1,
      status: 'failed',
      failure: 'The current recording check failed.',
    };
    const oldRefresh = deferred<Response>();
    let reads = 0;
    let ownerPoll: (() => void) | undefined;
    const interval = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(((handler: TimerHandler, timeout?: number) => {
        if (timeout === 10_000 && typeof handler === 'function') {
          ownerPoll = handler as () => void;
        }
        return 99;
      }) as typeof window.setInterval);
    mockFetch(
      routesFor(old, [
        {
          path: `/api/streams/${ID}`,
          respond: () => jsonOk(reads++ === 0 ? old : current),
        },
        {
          path: `/api/streams/${ID}/legacy-adoptions/${pendingLegacyPreparation().operationId}`,
          respond: () => oldRefresh.promise,
        },
      ]),
    );

    try {
      renderDetails();
      fireEvent.click(
        await screen.findByRole('button', { name: 'Refresh preparation' }),
      );
      expect(ownerPoll).toBeTypeOf('function');
      void act(() => ownerPoll?.());
      expect(
        await screen.findByText('The current recording check failed.'),
      ).toBeInTheDocument();

      oldRefresh.resolve(
        jsonOk({
          operation: {
            ...pendingLegacyPreparation(),
            revision: 99,
            status: 'failed',
            failure: 'A delayed older recording check failed.',
          },
        }),
      );

      await waitFor(() => {
        expect(
          screen.queryByText('A delayed older recording check failed.'),
        ).not.toBeInTheDocument();
      });
      expect(
        screen.getByText('The current recording check failed.'),
      ).toBeInTheDocument();
    } finally {
      interval.mockRestore();
    }
  });

  it('polls a pending recording check until ordinary continuation is available', async () => {
    const pending = legacyVod();
    pending.legacyAdoption = pendingLegacyPreparation();
    const ready = managedVod();
    let reads = 0;
    let ownerPoll: (() => void) | undefined;
    const interval = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(((handler: TimerHandler, timeout?: number) => {
        if (timeout === 10_000 && typeof handler === 'function') {
          ownerPoll = handler as () => void;
        }
        return 99;
      }) as typeof window.setInterval);
    mockFetch(
      routesFor(pending, [
        {
          path: `/api/streams/${ID}`,
          respond: () => jsonOk(reads++ === 0 ? pending : ready),
        },
      ]),
    );

    try {
      renderDetails();
      expect(
        await screen.findByText('Checking the previous recording.'),
      ).toBeInTheDocument();
      expect(ownerPoll).toBeTypeOf('function');

      void act(() => ownerPoll?.());

      expect(
        await screen.findByRole('button', { name: 'Continue stream' }),
      ).toBeEnabled();
      expect(
        screen.queryByText('Checking the previous recording.'),
      ).not.toBeInTheDocument();
    } finally {
      interval.mockRestore();
    }
  });

  it('warns when a published stream was edited after it was published', async () => {
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'published',
          publishedAt: '2026-09-11T10:00:00.000Z',
          updatedAt: '2026-09-11T10:05:00.000Z',
          publishedFeedIndex: 2,
        }),
      ),
    );

    renderDetails();

    expect(await screen.findByText(EDITED_SINCE_PUBLISH)).toBeInTheDocument();
    // Republish is the way out, so it has to be the button's label.
    expect(
      screen.getByRole('button', { name: /Republish/ }),
    ).toBeInTheDocument();
  });

  it('does not warn when the row has not changed since the publish', async () => {
    const at = '2026-09-11T10:00:00.000Z';
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'published',
          publishedAt: at,
          updatedAt: at,
          publishedFeedIndex: 2,
        }),
      ),
    );

    renderDetails();

    await screen.findByRole('button', { name: /Republish/ });
    expect(screen.queryByText(EDITED_SINCE_PUBLISH)).not.toBeInTheDocument();
  });

  it('does not warn for a draft, whatever its timestamps say', async () => {
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'draft',
          publishedAt: null,
          updatedAt: '2026-09-11T10:05:00.000Z',
        }),
      ),
    );

    renderDetails();

    await screen.findByRole('button', { name: 'Publish' });
    expect(screen.queryByText(EDITED_SINCE_PUBLISH)).not.toBeInTheDocument();
  });

  it('shows what the uploader reported, and only once it has', async () => {
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'vod',
          publishedAt: '2026-10-01T09:00:00.000Z',
          publishedFeedIndex: 2,
          liveSince: '2026-10-01T09:01:00.000Z',
          endedAt: '2026-10-01T10:02:05.000Z',
          durationSeconds: 3725.5,
          manifestIndex: 412,
        }),
      ),
    );

    renderDetails();

    expect(await screen.findByText('Live since')).toBeInTheDocument();
    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('1:02:06')).toBeInTheDocument();
    expect(screen.getByText('Manifest index')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();

    // A recording is off the feed like any published stream, and republishing
    // it keeps it a recording.
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Republish' })).toBeEnabled();
  });

  it('offers Publish but not Unpublish for a hidden managed recording', async () => {
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'vod',
          publishedAt: null,
          publishedFeedIndex: null,
          manifestIndex: 12,
          durationSeconds: 62.5,
          lifecycle: {
            version: 1,
            revision: 5,
            runNumber: 1,
            state: 'vod',
            permission: 'closed',
            canContinue: true,
          },
        }),
      ),
    );

    renderDetails();

    expect(await screen.findByRole('button', { name: 'Publish' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeDisabled();
  });

  it('leaves the reported fields off a stream nobody has streamed yet', async () => {
    mockFetch(routesFor(makeStream({ id: ID, status: 'published' })));

    renderDetails();

    // "Published" is both the status chip and a field label here, so the
    // load is waited on by something that appears exactly once.
    expect(await screen.findByText('Feed owner')).toBeInTheDocument();
    expect(screen.queryByText('Live since')).not.toBeInTheDocument();
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
    expect(screen.queryByText('Manifest index')).not.toBeInTheDocument();
  });

  it('expires active status from server age despite browser clock skew', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));
      const live = managedVod();
      live.lifecycle = {
        version: 1,
        revision: 8,
        runNumber: 2,
        state: 'live',
        permission: 'claimed',
        canContinue: false,
        receivedAt: '2099-01-01T00:00:00.000Z',
        observationAgeMs: 0,
      };
      const first = renderWithProviders(
        <ContinuationPanel stream={live} reload={() => undefined} />,
      );
      expect(screen.getByText('Run 2: Live')).toBeInTheDocument();
      void act(() => vi.advanceTimersByTime(30_000));
      expect(screen.getByText('Run 2: Status unavailable')).toBeInTheDocument();
      first.unmount();

      const closed = managedVod();
      closed.lifecycle = {
        version: 1,
        revision: 9,
        runNumber: 2,
        state: 'closed',
        permission: 'closed',
        closeReason: 'reconnect_timeout',
        canContinue: false,
        receivedAt: '2020-01-01T00:00:00.000Z',
        observationAgeMs: 999_999,
      };
      renderWithProviders(
        <ContinuationPanel stream={closed} reload={() => undefined} />,
      );
      expect(
        screen.getByText('Run 2: Finishing recording'),
      ).toBeInTheDocument();
      void act(() => vi.advanceTimersByTime(60_000));
      expect(
        screen.getByText('Run 2: Finishing recording'),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes an eligible empty close from recovery failure', () => {
    const empty = managedVod();
    empty.lifecycle = {
      version: 1,
      revision: 9,
      runNumber: 2,
      state: 'closed',
      permission: 'closed',
      closeReason: 'empty',
      canContinue: true,
    };
    const first = renderWithProviders(
      <ContinuationPanel stream={empty} reload={() => undefined} />,
    );
    expect(screen.getByText('Run 2: Closed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue stream' }),
    ).toBeEnabled();
    first.unmount();

    const recovery = managedVod();
    recovery.lifecycle = {
      version: 1,
      revision: 10,
      runNumber: 2,
      state: 'closed',
      permission: 'closed',
      closeReason: 'recovery_required',
      canContinue: false,
    };
    renderWithProviders(
      <ContinuationPanel stream={recovery} reload={() => undefined} />,
    );
    expect(screen.getByText('Run 2: Recovery required')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Recording recovery is required before this stream can continue.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue stream' }),
    ).not.toBeInTheDocument();
  });

  it('ages the server-relative reconnect countdown locally', () => {
    vi.useFakeTimers();
    let monotonicNow = 1_000;
    const now = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonicNow);
    try {
      const waiting = managedVod();
      waiting.lifecycle = {
        version: 1,
        revision: 9,
        runNumber: 2,
        state: 'waiting',
        permission: 'claimed',
        observationAgeMs: 0,
        reconnectRemainingMs: 60_000,
        canContinue: false,
      };
      renderWithProviders(
        <ContinuationPanel stream={waiting} reload={() => undefined} />,
      );
      expect(
        screen.getByText('Run 2: Waiting for reconnection (60s remaining)'),
      ).toBeInTheDocument();

      monotonicNow += 1_000;
      void act(() => vi.advanceTimersByTime(1_000));

      expect(
        screen.getByText('Run 2: Waiting for reconnection (59s remaining)'),
      ).toBeInTheDocument();
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it('tells the owner how to resume OBS when continuation is ready', () => {
    const ready = managedVod();
    ready.lifecycle = {
      version: 1,
      revision: 7,
      runNumber: 2,
      state: 'ready',
      permission: 'open',
      canContinue: false,
    };
    ready.continuation = {
      ...pendingOperation(),
      status: 'ready',
      revision: 7,
    };

    renderWithProviders(
      <ContinuationPanel stream={ready} reload={() => undefined} />,
    );

    expect(
      screen.getByText(
        'OBS may reconnect automatically. If it does not, choose Start Streaming.',
      ),
    ).toBeInTheDocument();
  });

  it('counts a delayed owner response against active status freshness', async () => {
    const response = deferred<Response>();
    let requested = false;
    let monotonicNow = 1_000;
    const now = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonicNow);
    const live = managedVod();
    live.lifecycle = {
      version: 1,
      revision: 8,
      runNumber: 2,
      state: 'live',
      permission: 'claimed',
      canContinue: false,
      observationAgeMs: 15_000,
    };
    mockFetch(
      routesFor(live, [
        {
          path: `/api/streams/${ID}`,
          respond: () => {
            requested = true;
            return response.promise;
          },
        },
      ]),
    );

    try {
      renderDetails();
      await waitFor(() => expect(requested).toBe(true));
      monotonicNow += 20_000;
      response.resolve(jsonOk(live));

      expect(
        await screen.findByText('Run 2: Status unavailable'),
      ).toBeInTheDocument();
    } finally {
      now.mockRestore();
    }
  });

  it('counts a delayed owner response against reconnect time remaining', async () => {
    const response = deferred<Response>();
    let requested = false;
    let monotonicNow = 1_000;
    const now = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonicNow);
    const waiting = managedVod();
    waiting.lifecycle = {
      version: 1,
      revision: 8,
      runNumber: 2,
      state: 'waiting',
      permission: 'claimed',
      canContinue: false,
      observationAgeMs: 0,
      reconnectRemainingMs: 60_000,
    };
    mockFetch(
      routesFor(waiting, [
        {
          path: `/api/streams/${ID}`,
          respond: () => {
            requested = true;
            return response.promise;
          },
        },
      ]),
    );

    try {
      renderDetails();
      await waitFor(() => expect(requested).toBe(true));
      monotonicNow += 10_000;
      response.resolve(jsonOk(waiting));

      expect(
        await screen.findByText(
          'Run 2: Waiting for reconnection (50s remaining)',
        ),
      ).toBeInTheDocument();
    } finally {
      now.mockRestore();
    }
  });

  it('offers a refresh while publishing leaves both buttons disabled', async () => {
    let status: Stream['status'] = 'publishing';
    mockFetch([
      {
        path: `/api/streams/${ID}`,
        respond: () => jsonOk(makeStream({ id: ID, status })),
      },
      { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest()) },
      {
        path: '/api/config',
        respond: () =>
          jsonOk({
            feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff' },
            viewerBaseUrl: null,
          }),
      },
    ]);

    renderDetails();

    expect(await screen.findByText('Publishing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeDisabled();

    // Without this the operator has no way off a screen that will not change
    // on its own.
    const refresh = screen.getByLabelText('refresh stream');
    expect(refresh).toBeEnabled();

    status = 'published';
    fireEvent.click(refresh);

    expect(await screen.findByText('Published')).toBeInTheDocument();
  });

  it('links to the viewer catalogue, not the stream route, and shows the route as text', async () => {
    const stream = makeStream({ id: ID, status: 'draft', mediaType: 'video' });
    mockFetch([
      { path: `/api/streams/${ID}`, respond: () => jsonOk(stream) },
      { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest()) },
      {
        path: '/api/config',
        respond: () =>
          jsonOk({
            feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff' },
            viewerBaseUrl: 'https://player.example.com/',
          }),
      },
    ]);

    renderDetails();

    // The viewer only plays a stream once the uploader has written a manifest
    // under its topic, so the link goes to the catalogue the viewer was built for.
    const link = await screen.findByRole('link', { name: /Open player catalogue/ });
    expect(link).toHaveAttribute('href', 'https://player.example.com/#/');
    expect(
      screen.getByText(`#/watch/video/${stream.owner}/${stream.topic}`),
    ).toBeInTheDocument();
  });

  it('reports an unpublish without claiming the feed was rewritten', async () => {
    const published = makeStream({
      id: ID,
      status: 'published',
      publishedAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:00:00.000Z',
      publishedFeedIndex: 4,
    });
    mockFetch(
      routesFor(published, [
        {
          method: 'POST',
          path: `/api/streams/${ID}/unpublish`,
          respond: () =>
            jsonOk({
              stream: { ...published, status: 'draft', publishedAt: null },
              feed: {
                owner: 'abc',
                topic: 'swarm-stream',
                topicHex: 'ff',
                index: 4,
                entryCount: 0,
              },
            }),
        },
      ]),
    );

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));

    expect(
      await screen.findByText('Unpublished. Feed is at index 4.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Draft')).toBeInTheDocument();
    });
  });

  it('reuses the same request id when the Continue response is lost', async () => {
    const requests: Array<{ requestId: string; expectedRevision: number }> = [];
    mockFetch(
      routesFor(managedVod(), [
        {
          method: 'POST',
          path: `/api/streams/${ID}/continuations`,
          respond: (init) => {
            if (typeof init?.body !== 'string') {
              throw new TypeError('expected a JSON request body');
            }
            requests.push(JSON.parse(init.body) as (typeof requests)[number]);
            return requests.length === 1
              ? Promise.reject(new TypeError('response lost'))
              : jsonOk({ operation: pendingOperation() }, 202);
          },
        },
      ]),
    );

    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue stream' }),
    );

    expect(await screen.findByText(/Preparing continuation\. Run 2\./)).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.expectedRevision).toBe(5);
    expect(screen.getByRole('button', { name: 'Cancel continuation' })).toBeEnabled();
    expect(screen.getByText('Previous replay: run 1, 12:05')).toBeInTheDocument();
  });

  it('adopts the owner-scoped current operation after a page reload', async () => {
    const stream = managedVod();
    stream.continuation = pendingOperation();
    mockFetch(routesFor(stream));

    renderDetails();

    expect(await screen.findByText(/Preparing continuation\. Run 2\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel continuation' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Continue stream' })).not.toBeInTheDocument();
  });

  it('polls a pending continuation until preparation is ready', async () => {
    const pending = managedVod();
    pending.continuation = pendingOperation();
    const ready = managedVod();
    ready.lifecycle = {
      version: 1,
      revision: 7,
      runNumber: 2,
      state: 'ready',
      permission: 'open',
      canContinue: false,
    };
    ready.continuation = {
      ...pendingOperation(),
      status: 'ready',
      revision: 7,
    };
    let reads = 0;
    let ownerPoll: (() => void) | undefined;
    const interval = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(((handler: TimerHandler, timeout?: number) => {
        if (timeout === 10_000 && typeof handler === 'function') {
          ownerPoll = handler as () => void;
        }
        return 99;
      }) as typeof window.setInterval);
    mockFetch(
      routesFor(pending, [
        {
          path: `/api/streams/${ID}`,
          respond: () => jsonOk(reads++ === 0 ? pending : ready),
        },
      ]),
    );

    try {
      renderDetails();
      expect(
        await screen.findByText(/Preparing continuation\. Run 2\./),
      ).toBeInTheDocument();
      expect(ownerPoll).toBeTypeOf('function');
      void act(() => ownerPoll?.());
      expect(
        await screen.findByText(/Ready for OBS\. Run 2\./),
      ).toBeInTheDocument();
    } finally {
      interval.mockRestore();
    }
  });

  it('refuses a newer request whose lifecycle revision moved backward', async () => {
    const current = managedVod();
    current.lifecycle = {
      version: 1,
      revision: 7,
      runNumber: 2,
      state: 'ready',
      permission: 'open',
      canContinue: false,
    };
    current.continuation = {
      ...pendingOperation(),
      status: 'ready',
      revision: 7,
    };
    const stale = managedVod();
    stale.lifecycle = {
      version: 1,
      revision: 6,
      runNumber: 1,
      state: 'closed',
      permission: 'closed',
      closeReason: 'empty',
      canContinue: true,
    };
    let reads = 0;
    mockFetch(
      routesFor(current, [
        {
          path: `/api/streams/${ID}`,
          respond: () => jsonOk(reads++ === 0 ? current : stale),
        },
      ]),
    );
    renderDetails();
    expect(await screen.findByText('Run 2: Ready for OBS')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('refresh stream'));

    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByText('Run 2: Ready for OBS')).toBeInTheDocument();
    expect(screen.queryByText('Run 1: Finishing recording')).not.toBeInTheDocument();
  });

  it('does not let a delayed operation reply replace a newer revision', async () => {
    const oldReply = deferred<Response>();
    const stream = managedVod();
    const ready = { ...pendingOperation(), status: 'ready' as const, revision: 7 };
    stream.continuation = ready;
    mockFetch(
      routesFor(stream, [
        {
          path: `/api/streams/${ID}/continuations/${ready.operationId}`,
          respond: () => oldReply.promise,
        },
      ]),
    );
    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Refresh continuation' }),
    );

    oldReply.resolve(
      jsonOk({ operation: { ...pendingOperation(), revision: 6 } }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Ready for OBS\. Run 2\./)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Preparing continuation\. Run 2\./)).not.toBeInTheDocument();
  });

  it('clears a tab conflict only after owner state reconciles', async () => {
    const initial = managedVod();
    const initialLifecycle = initial.lifecycle;
    if (!initialLifecycle) throw new Error('managed fixture needs lifecycle');
    const reconciled = deferred<Response>();
    let streamReads = 0;
    mockFetch(
      routesFor(initial, [
        {
          path: `/api/streams/${ID}`,
          respond: () => {
            streamReads += 1;
            return streamReads === 1 ? jsonOk(initial) : reconciled.promise;
          },
        },
        {
          method: 'POST',
          path: `/api/streams/${ID}/continuations`,
          respond: () => jsonError(409, { error: 'revision_conflict' }),
        },
      ]),
    );
    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue stream' }),
    );
    expect(
      await screen.findAllByText(
        'Another tab changed this stream. Refresh before trying again.',
      ),
    ).toHaveLength(2);

    const current = pendingOperation();
    reconciled.resolve(
      jsonOk({
        ...initial,
        lifecycle: { ...initialLifecycle, revision: 6 },
        continuation: current,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getAllByText(
          'Another tab changed this stream. Refresh before trying again.',
        ),
      ).toHaveLength(1);
    });
    expect(screen.getByText(/Preparing continuation\. Run 2\./)).toBeInTheDocument();
  });

  it('cancels a prepared continuation before it is claimed', async () => {
    const operation = pendingOperation();
    mockFetch(
      routesFor(managedVod(), [
        {
          method: 'POST',
          path: `/api/streams/${ID}/continuations`,
          respond: () => jsonOk({ operation }, 202),
        },
        {
          method: 'DELETE',
          path: `/api/streams/${ID}/continuations/${operation.operationId}`,
          respond: () =>
            jsonOk({ operation: { ...operation, status: 'cancelled', revision: 7 } }),
        },
      ]),
    );

    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue stream' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel continuation' }),
    );

    expect(await screen.findByText(/Continuation cancelled\. Run 2\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel continuation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue stream' })).toBeEnabled();
  });

  it('removes Cancel after refresh reports that the uploader claimed the run', async () => {
    const operation = pendingOperation();
    mockFetch(
      routesFor(managedVod(), [
        {
          method: 'POST',
          path: `/api/streams/${ID}/continuations`,
          respond: () => jsonOk({ operation }, 202),
        },
        {
          path: `/api/streams/${ID}/continuations/${operation.operationId}`,
          respond: () =>
            jsonOk({ operation: { ...operation, status: 'claimed', revision: 8 } }),
        },
      ]),
    );

    renderDetails();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue stream' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Refresh continuation' }),
    );

    expect(await screen.findByText(/Continuation claimed\. Run 2\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel continuation' })).not.toBeInTheDocument();
  });

  it('shows one winner and a typed conflict when two tabs Continue together', async () => {
    const posts: Array<{
      body: { requestId: string; expectedRevision: number };
      response: ReturnType<typeof deferred<Response>>;
    }> = [];
    mockFetch(
      routesFor(managedVod(), [
        {
          method: 'POST',
          path: `/api/streams/${ID}/continuations`,
          respond: (init) => {
            if (typeof init?.body !== 'string') {
              throw new TypeError('expected a JSON request body');
            }
            const response = deferred<Response>();
            posts.push({
              body: JSON.parse(init.body) as (typeof posts)[number]['body'],
              response,
            });
            return response.promise;
          },
        },
      ]),
    );

    renderWithProviders(
      <Routes>
        <Route
          path="/streams/:id"
          element={
            <>
              <StreamDetailsPage />
              <StreamDetailsPage />
            </>
          }
        />
      </Routes>,
      { route: `/streams/${ID}` },
    );

    const buttons = await screen.findAllByRole('button', {
      name: 'Continue stream',
    });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]?.body.requestId).not.toBe(posts[1]?.body.requestId);

    posts[0]?.response.resolve(
      jsonOk({ operation: pendingOperation('88888888-8888-4888-8888-888888888881') }, 202),
    );
    posts[1]?.response.resolve(jsonError(409, { error: 'revision_conflict' }));

    expect(await screen.findByText(/Preparing continuation\. Run 2\./)).toBeInTheDocument();
    expect(
      await screen.findAllByText(
        'Another tab changed this stream. Refresh before trying again.',
      ),
    ).toHaveLength(2);
  });
});
