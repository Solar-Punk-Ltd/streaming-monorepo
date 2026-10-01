import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Stream } from '@streaming-monorepo/web2-admin-common';

import { NO_STAGE_NOTE } from '../components/IngestPanel';
import { NEEDS_STAGE_HINT, StreamDetailsPage, UP_TO_DATE_HINT } from '../pages/StreamDetailsPage';
import {
  MAIN_STAGE_ID,
  jsonError,
  jsonOk,
  makeIngest,
  makeStream,
  mockFetch,
  type Route as MockRoute,
  renderWithProviders,
} from './helpers';

const ID = 'stream-under-test';

const EDITED_SINCE_PUBLISH = 'Edited since it was published. Republish to update the feed.';

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

describe('StreamDetailsPage', () => {
  it('names the stage the stream is on, from its OBS details', async () => {
    mockFetch(routesFor(makeStream({ id: ID, stageId: 'stage-1' })));

    renderDetails();

    const field = (await screen.findByText('Stage')).parentElement as HTMLElement;
    await waitFor(() => expect(within(field).getByText('Main stage')).toBeInTheDocument());
  });

  it('says a stream has no stage, and the OBS panel says to pick one', async () => {
    mockFetch([
      { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest({ stage: null, srt: null })) },
      ...routesFor(makeStream({ id: ID, stageId: null })),
    ]);

    renderDetails();

    const field = (await screen.findByText('Stage')).parentElement as HTMLElement;
    expect(within(field).getByText('No stage')).toBeInTheDocument();
    expect(await screen.findByText(NO_STAGE_NOTE)).toBeInTheDocument();
  });

  it('keeps Publish disabled on a draft with no stage, and says why', async () => {
    mockFetch(routesFor(makeStream({ id: ID, status: 'draft', stageId: null })));

    renderDetails();

    expect(await screen.findByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByText(NEEDS_STAGE_HINT)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit the stream' })).toHaveAttribute('href', `/edit/${ID}`);
  });

  it('offers Publish on a draft on a stage', async () => {
    mockFetch(routesFor(makeStream({ id: ID, status: 'draft', stageId: MAIN_STAGE_ID })));

    renderDetails();

    expect(await screen.findByRole('button', { name: 'Publish' })).toBeEnabled();
    expect(screen.queryByText(NEEDS_STAGE_HINT)).not.toBeInTheDocument();
  });

  it.each(['published', 'live', 'vod'] as const)(
    'keeps Republish disabled on a %s stream the catalogue already carries, and says so',
    async (status) => {
      mockFetch(
        routesFor(
          makeStream({ id: ID, status, publishedFeedIndex: 2, stageId: MAIN_STAGE_ID, hasUnpublishedEdits: false }),
        ),
      );

      renderDetails();

      expect(await screen.findByRole('button', { name: 'Republish' })).toBeDisabled();
      expect(screen.getByText(UP_TO_DATE_HINT)).toBeInTheDocument();
    },
  );

  it('offers Republish once the console holds an edit the entry does not carry', async () => {
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'published',
          publishedFeedIndex: 2,
          stageId: MAIN_STAGE_ID,
          hasUnpublishedEdits: true,
        }),
      ),
    );

    renderDetails();

    expect(await screen.findByRole('button', { name: 'Republish' })).toBeEnabled();
    expect(screen.queryByText(UP_TO_DATE_HINT)).not.toBeInTheDocument();
  });

  it('offers Republish after a failed publish attempt, which a retry has to redo', async () => {
    // A live report whose catalogue write failed: nothing was edited, and the
    // entry still says the stream has not started.
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'live',
          publishedFeedIndex: 2,
          stageId: MAIN_STAGE_ID,
          hasUnpublishedEdits: false,
          publishError: 'bee unreachable',
        }),
      ),
    );

    renderDetails();

    expect(await screen.findByRole('button', { name: 'Republish' })).toBeEnabled();
    expect(screen.queryByText(UP_TO_DATE_HINT)).not.toBeInTheDocument();
  });

  it('says so when a republish had nothing to write', async () => {
    // An edit that left the entry as it was, a title changed and changed back:
    // the API writes nothing and the notice clears.
    const edited = makeStream({
      id: ID,
      status: 'published',
      publishedFeedIndex: 4,
      stageId: MAIN_STAGE_ID,
      hasUnpublishedEdits: true,
    });
    mockFetch(
      routesFor(edited, [
        {
          method: 'POST',
          path: `/api/streams/${ID}/publish`,
          respond: () =>
            jsonOk({
              stream: { ...edited, hasUnpublishedEdits: false },
              feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff', index: 4, entryCount: 1 },
              written: false,
            }),
        },
      ]),
    );

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Republish' }));

    expect(
      await screen.findByText('Nothing to write: the catalogue already has this edit, at feed index 4.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Republish' })).toBeDisabled();
    expect(screen.getByText(UP_TO_DATE_HINT)).toBeInTheDocument();
  });

  it('says where a publish that wrote landed', async () => {
    const draft = makeStream({ id: ID, status: 'draft', stageId: MAIN_STAGE_ID });
    mockFetch(
      routesFor(draft, [
        {
          method: 'POST',
          path: `/api/streams/${ID}/publish`,
          respond: () =>
            jsonOk({
              stream: { ...draft, status: 'published', publishedFeedIndex: 5 },
              feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff', index: 5, entryCount: 1 },
              written: true,
            }),
        },
      ]),
    );

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Published at feed index 5.')).toBeInTheDocument();
  });

  it('warns when the API reports edits the catalogue entry does not carry', async () => {
    // The timestamps are equal on purpose: the notice is the API's answer, not
    // a comparison the page makes of its own.
    const at = '2026-09-11T10:00:00.000Z';
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'vod',
          publishedAt: at,
          updatedAt: at,
          publishedFeedIndex: 2,
          hasUnpublishedEdits: true,
        }),
      ),
    );

    renderDetails();

    expect(await screen.findByText(EDITED_SINCE_PUBLISH)).toBeInTheDocument();
    // Republish is the way out, so it has to be the button's label.
    expect(screen.getByRole('button', { name: /Republish/ })).toBeInTheDocument();
  });

  it('does not warn about a stream that only the uploader has moved on', async () => {
    // Seen on the deployed admin on 2026-09-24: created, published, broadcast
    // once and never edited, and the uploader's reports had carried
    // `updatedAt` past `publishedAt`.
    mockFetch(
      routesFor(
        makeStream({
          id: ID,
          status: 'vod',
          publishedAt: '2026-09-11T10:00:00.000Z',
          updatedAt: '2026-09-11T11:30:00.000Z',
          publishedFeedIndex: 2,
          liveSince: '2026-09-11T10:01:00.000Z',
          endedAt: '2026-09-11T11:30:00.000Z',
          hasUnpublishedEdits: false,
        }),
      ),
    );

    renderDetails();

    await screen.findByRole('button', { name: /Republish/ });
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

    // A recording can be taken off the feed like any published stream. Nobody
    // edited this one, so the catalogue already carries it and there is
    // nothing to republish.
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Republish' })).toBeDisabled();
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
    expect(screen.getByText(`#/watch/video/${stream.owner}/${stream.topic}`)).toBeInTheDocument();
  });

  it('reports an unpublish without claiming the feed was rewritten', async () => {
    const published = makeStream({
      id: ID,
      status: 'published',
      publishedAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:00:00.000Z',
      publishedFeedIndex: 4,
    });
    mockFetch(routesFor(published, [unpublishRoute(published)]));

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Unpublish',
      }),
    );

    expect(await screen.findByText('Unpublished. Feed is at index 4.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Draft')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('asks before unpublishing a recording, and says the recording is kept', async () => {
    // A recording comes off the catalogue, and viewers lose it until it is
    // published again, so one click is not enough.
    const recording = recordingStream();
    const fetchMock = mockFetch(routesFor(recording, [unpublishRoute(recording)]));

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unpublish recording')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('stops being listed in the catalogue');
    expect(dialog).toHaveTextContent('this admin keeps where it is, how long it runs and when it was live');
    expect(dialog).toHaveTextContent('Publish it again to list it as this recording');
    expect(unpublishCalls(fetchMock)).toBe(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(unpublishCalls(fetchMock)).toBe(0);
    expect(screen.getByText('Manifest index')).toBeInTheDocument();
  });

  it('still shows the recording once it is unpublished back to a draft', async () => {
    const recording = recordingStream();
    mockFetch(routesFor(recording, [unpublishRoute(recording)]));

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Unpublish',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('Draft')).toBeInTheDocument();
    });
    // An open dialog hides the rest of the page from role queries.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Manifest index')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('asks with a shorter message for a stream that has not gone live', async () => {
    const published = makeStream({
      id: ID,
      status: 'published',
      publishedAt: '2026-09-11T10:00:00.000Z',
      publishedFeedIndex: 4,
    });
    const fetchMock = mockFetch(routesFor(published, [unpublishRoute(published)]));

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unpublish stream')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('stops being listed in the catalogue and goes back to a draft');
    expect(dialog).not.toHaveTextContent('recording');
    expect(unpublishCalls(fetchMock)).toBe(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));

    expect(await screen.findByText('Unpublished. Feed is at index 4.')).toBeInTheDocument();
    expect(unpublishCalls(fetchMock)).toBe(1);
  });

  it('keeps the dialog open when the unpublish fails, to retry or cancel', async () => {
    const published = makeStream({
      id: ID,
      status: 'published',
      publishedAt: '2026-09-11T10:00:00.000Z',
      publishedFeedIndex: 4,
    });
    mockFetch(
      routesFor(published, [
        {
          method: 'POST',
          path: `/api/streams/${ID}/unpublish`,
          respond: () =>
            jsonError(502, {
              error: 'publish_failed',
              message: 'bee unreachable',
            }),
        },
      ]),
    );

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Unpublish',
      }),
    );

    expect(await screen.findByText('bee unreachable')).toBeInTheDocument();
    // MUI keeps a closing dialog on the page for its exit transition, so
    // "still there" proves nothing until that time has passed.
    await expect(
      waitFor(
        () => {
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        },
        { timeout: 600 },
      ),
    ).rejects.toThrow();
    expect(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Unpublish',
      }),
    ).toBeEnabled();
  });
});

/** A stream the uploader reported as a finished recording. */
function recordingStream(): Stream {
  return makeStream({
    id: ID,
    status: 'vod',
    publishedAt: '2026-09-11T10:00:00.000Z',
    publishedFeedIndex: 4,
    liveSince: '2026-09-11T10:01:00.000Z',
    endedAt: '2026-09-11T11:00:00.000Z',
    durationSeconds: 3540,
    manifestIndex: 412,
    stageId: MAIN_STAGE_ID,
  });
}

/**
 * The API's answer to an unpublish of `stream`: back to a draft and off the
 * catalogue, with the recording kept.
 */
function unpublishRoute(stream: Stream): MockRoute {
  return {
    method: 'POST',
    path: `/api/streams/${ID}/unpublish`,
    respond: () =>
      jsonOk({
        stream: {
          ...stream,
          status: 'draft',
          publishedAt: null,
          publishedFeedIndex: null,
        },
        feed: {
          owner: 'abc',
          topic: 'swarm-stream',
          topicHex: 'ff',
          index: 4,
          entryCount: 0,
        },
        written: true,
      }),
  };
}

function unpublishCalls(fetchMock: ReturnType<typeof mockFetch>): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === `/api/streams/${ID}/unpublish` && init?.method === 'POST',
  ).length;
}
