import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  OwnerContinuationOperation,
  Stream,
} from '@streaming-monorepo/web2-admin-common';

import { StreamDetailsPage } from '../pages/StreamDetailsPage';
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

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

describe('StreamDetailsPage', () => {
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

  it('marks stale active status unavailable while closed status stays durable', async () => {
    const staleReceivedAt = new Date(Date.now() - 60_000).toISOString();
    const live = managedVod();
    live.lifecycle = {
      version: 1,
      revision: 8,
      runNumber: 2,
      state: 'live',
      permission: 'claimed',
      receivedAt: staleReceivedAt,
    };
    mockFetch(routesFor(live));
    const first = renderDetails();
    expect(await screen.findByText('Run 2: status unavailable')).toBeInTheDocument();
    first.unmount();

    const closed = managedVod();
    closed.lifecycle = {
      version: 1,
      revision: 9,
      runNumber: 2,
      state: 'closed',
      permission: 'closed',
      receivedAt: staleReceivedAt,
    };
    mockFetch(routesFor(closed));
    renderDetails();
    expect(await screen.findByText('Run 2: closed')).toBeInTheDocument();
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
    expect(screen.getByText(/Previous replay: run 1, master index 32/)).toBeInTheDocument();
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
