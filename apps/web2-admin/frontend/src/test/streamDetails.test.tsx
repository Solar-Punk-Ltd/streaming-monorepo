import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { IngestDetails, Stream } from '@streaming-monorepo/web2-admin-common';

import { NO_STAGE_NOTE } from '../components/IngestPanel';
import { formatDateTime } from '../dateUtil';
import { shortHex } from '../format';
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

/** A time this many minutes from now. The page reads `restartUntil` against the clock, so these follow it. */
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const LIVE_SINCE = minutesFromNow(-70);
const ENDED_AT = minutesFromNow(-5);
const RESTART_UNTIL = minutesFromNow(25);
const FINISHED_AT = minutesFromNow(-1);

/** The status notice under the title, word for word as the plan puts it. */
const LIVE_TITLE = `Live since ${formatDateTime(LIVE_SINCE)}`;
const LIVE_HELPER = 'Finalize is enabled once live streaming has ended.';
const ENDED_TITLE = `Ended — can go live again until ${formatDateTime(RESTART_UNTIL)}`;
const RUN_OUT_TITLE = 'Ended — its restart window has run out';
const ENDED_HELPER = 'Finalize will rotate the SRT key to protect this stream.';
const FINALIZED_TITLE = 'Finalized — the SRT key has changed';
const FINALIZED_HELPER = 'The old SRT line is refused. To go live on purpose, copy the new one.';

const FINALIZE_TEXT =
  'Its key changes now, so no encoder can start it again on the old key. To go live on it later on purpose, copy ' +
  'the new SRT line.';

const NEW_KEY = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** A stream in each state the status notice tells apart, once it has gone live. */
const STATES = {
  live: { status: 'live', liveSince: LIVE_SINCE, finishedAt: null },
  // QA's tests on rc.6 left live rows that carry a finalized time.
  liveWithFinishedAt: { status: 'live', liveSince: LIVE_SINCE, finishedAt: FINISHED_AT },
  ended: { status: 'vod', liveSince: LIVE_SINCE, endedAt: ENDED_AT, restartUntil: RESTART_UNTIL, finishedAt: null },
  runOut: {
    status: 'vod',
    liveSince: LIVE_SINCE,
    endedAt: minutesFromNow(-31),
    restartUntil: minutesFromNow(-1),
    finishedAt: null,
  },
  finalized: { status: 'vod', liveSince: LIVE_SINCE, endedAt: ENDED_AT, restartUntil: null, finishedAt: FINISHED_AT },
} as const satisfies Record<string, Partial<Stream>>;

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

  it('tells the catalogue’s owner from the stream’s feed owner once it has published', async () => {
    // The stream's feeds are signed by its stage's key and the catalogue by
    // the brand key. The line under the buttons named the catalogue's just
    // "owner", below a "Feed owner" that is the stage's.
    const catalogueOwner = '5ef3a1b2c3d4e5f60718293a4b5c6d7e8f901234';
    const draft = makeStream({ id: ID, status: 'draft', stageId: MAIN_STAGE_ID });
    mockFetch(
      routesFor(draft, [
        {
          method: 'POST',
          path: `/api/streams/${ID}/publish`,
          respond: () =>
            jsonOk({
              stream: { ...draft, status: 'published', publishedAt: '2026-09-11T10:00:00.000Z', publishedFeedIndex: 7 },
              feed: { owner: catalogueOwner, topic: 'swarm-stream', topicHex: 'ff', index: 7, entryCount: 3 },
            }),
        },
      ]),
    );

    renderDetails();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText(/^Catalogue feed index 7/)).toHaveTextContent(
      `Catalogue feed index 7 · 3 entries · catalogue owner ${shortHex(catalogueOwner, 10, 8)} · catalogue topic swarm-stream`,
    );
    const feedOwner = screen.getByText('Feed owner').parentElement as HTMLElement;
    expect(feedOwner).toHaveTextContent(shortHex(draft.owner, 10, 8));
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

  it.each([
    ['a live stream', STATES.live, LIVE_TITLE, LIVE_HELPER, false],
    ['a live stream that carries a finalized time', STATES.liveWithFinishedAt, LIVE_TITLE, LIVE_HELPER, false],
    ['an ended stream inside its restart window', STATES.ended, ENDED_TITLE, ENDED_HELPER, true],
    ['an ended stream whose restart window has run out', STATES.runOut, RUN_OUT_TITLE, ENDED_HELPER, true],
    ['a finalized stream', STATES.finalized, FINALIZED_TITLE, FINALIZED_HELPER, false],
  ] as const)(
    'says under the title where %s stands, and whether it can be finalized',
    async (_, fields, title, helper, enabled) => {
      mockFetch(routesFor(makeStream({ id: ID, stageId: MAIN_STAGE_ID, publishedFeedIndex: 2, ...fields })));

      renderDetails();

      const notice = (await screen.findByText(title)).closest('[role="alert"]') as HTMLElement;
      expect(within(notice).getByText(helper)).toBeInTheDocument();
      // Finalize sits in the notice, and only there.
      expect((within(notice).getByRole('button', { name: 'Finalize' }) as HTMLButtonElement).disabled).toBe(!enabled);
      expect(screen.getAllByRole('button', { name: /Finali[sz]e|Finish/ })).toHaveLength(1);
      // The lines of the Finish round are gone.
      expect(screen.queryByText(/Live — finished|Finished — /)).not.toBeInTheDocument();
    },
  );

  it.each([
    ['a draft', { status: 'draft' }],
    ['a stream being published', { status: 'publishing' }],
    ['a published stream that never went live', { status: 'published', publishedFeedIndex: 2 }],
  ] as const)('has no status notice and no Finalize on %s', async (_, fields) => {
    mockFetch(routesFor(makeStream({ id: ID, stageId: MAIN_STAGE_ID, ...fields })));

    renderDetails();

    // The page and its OBS panel have loaded once Rotate key shows.
    expect(await screen.findByRole('button', { name: /Rotate key/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finali[sz]e|Finish/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Live since|Ended — |Finalized — /)).not.toBeInTheDocument();
  });

  it.each([
    ['enabled, on an ended stream', STATES.ended],
    ['disabled, on a live stream', STATES.live],
  ] as const)('says what Finalize does on hover, %s', async (_, fields) => {
    mockFetch(routesFor(makeStream({ id: ID, stageId: MAIN_STAGE_ID, publishedFeedIndex: 2, ...fields })));

    renderDetails();

    // A disabled button takes no pointer events, so the tooltip hangs on its wrapper.
    const finalize = await screen.findByRole('button', { name: 'Finalize' });
    fireEvent.mouseOver(finalize.parentElement as HTMLElement);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Finalize streaming');
  });

  it('finalizes an ended stream once confirmed, then shows its new SRT line and says it is finalized', async () => {
    const ended = makeStream({ id: ID, stageId: MAIN_STAGE_ID, publishedFeedIndex: 2, ...STATES.ended });
    const renewed = ingestWithKey(NEW_KEY, FINISHED_AT);
    const fetchMock = mockFetch(
      routesFor(ended, [finishRoute({ ...ended, restartUntil: null, finishedAt: FINISHED_AT }, renewed)]),
    );

    renderDetails();

    expect(await screen.findByText(ENDED_TITLE)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Finalize this stream?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(FINALIZE_TEXT);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(calls(fetchMock, 'POST', `/api/streams/${ID}/finish`)).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finalize' }));

    expect(await screen.findByText('Stream finalized. Its key has changed.')).toBeInTheDocument();
    expect(await screen.findByText(FINALIZED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(FINALIZED_HELPER)).toBeInTheDocument();
    expect(screen.queryByText(ENDED_TITLE)).not.toBeInTheDocument();
    // An open dialog hides the rest of the page from role queries.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();

    // The new key comes from the answer, so the page reads nothing again.
    fireEvent.click(screen.getByLabelText('show srt server'));
    expect(screen.getByLabelText('SRT Server')).toHaveValue(
      `${renewed.srt!.url}&passphrase=${renewed.srt!.passphrase}`,
    );
    expect(calls(fetchMock, 'POST', `/api/streams/${ID}/finish`)).toBe(1);
    expect(calls(fetchMock, 'GET', `/api/streams/${ID}/ingest`)).toBe(1);
    expect(calls(fetchMock, 'GET', `/api/streams/${ID}`)).toBe(1);
  });

  it.each([
    // It went live again on its key, inside its window.
    ['stream_live', 'Stop the broadcast first.', STATES.live, LIVE_TITLE],
    // Its window ran out and the admin finalized it, or someone did elsewhere.
    ['stream_finished', 'This stream is already finalized: its key has changed.', STATES.finalized, FINALIZED_TITLE],
    // Someone unpublished it, back to a draft.
    ['stream_not_started', 'Only an ended stream can be finalized.', { status: 'draft' }, 'Draft'],
  ] as const)(
    'reads the stream again after Finalize is refused as %s, and says why',
    async (code, sentence, now, shown) => {
      const ended = makeStream({ id: ID, stageId: MAIN_STAGE_ID, publishedFeedIndex: 2, ...STATES.ended });
      const renewed = ingestWithKey(NEW_KEY, FINISHED_AT);
      let current: Stream = ended;
      let currentIngest = makeIngest();
      const fetchMock = mockFetch([
        { path: `/api/streams/${ID}`, respond: () => jsonOk(current) },
        { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(currentIngest) },
        {
          path: '/api/config',
          respond: () => jsonOk({ feed: { owner: 'abc', topic: 'swarm-stream', topicHex: 'ff' }, viewerBaseUrl: null }),
        },
        {
          method: 'POST',
          path: `/api/streams/${ID}/finish`,
          // A message of the API's own, to show that the console's sentence wins.
          respond: () => jsonError(409, { error: code, id: ID, message: 'Refused.' }),
        },
      ]);

      renderDetails();

      fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
      const dialog = await screen.findByRole('dialog');
      current = { ...ended, ...now };
      currentIngest = renewed;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Finalize' }));

      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText('Refused.')).not.toBeInTheDocument();
      // The stream is no longer where the page showed it, so asking again cannot help.
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(await screen.findByText(shown)).toBeInTheDocument();
      expect(screen.queryByText(ENDED_TITLE)).not.toBeInTheDocument();

      // The SRT line on the page is the one the API holds now, not a stale one.
      fireEvent.click(screen.getByLabelText('show srt server'));
      expect(screen.getByLabelText('SRT Server')).toHaveValue(
        `${renewed.srt!.url}&passphrase=${renewed.srt!.passphrase}`,
      );
      expect(calls(fetchMock, 'GET', `/api/streams/${ID}`)).toBe(2);
      expect(calls(fetchMock, 'GET', `/api/streams/${ID}/ingest`)).toBe(2);
    },
  );

  it('keeps the dialog open after a failure that is no refusal, to retry or cancel, and reads nothing again', async () => {
    const ended = makeStream({ id: ID, stageId: MAIN_STAGE_ID, publishedFeedIndex: 2, ...STATES.ended });
    const fetchMock = mockFetch(
      routesFor(ended, [
        {
          method: 'POST',
          path: `/api/streams/${ID}/finish`,
          respond: () => jsonError(500, { error: 'internal_error' }),
        },
      ]),
    );

    renderDetails();

    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Finalize' }));

    expect(await screen.findByText('The server hit an unexpected error.')).toBeInTheDocument();
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
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Finalize' })).toBeEnabled();
    expect(calls(fetchMock, 'GET', `/api/streams/${ID}`)).toBe(1);
  });
});

/** The API's answer to a Finish: the stream as it now stands, and its OBS details with the new key. */
function finishRoute(stream: Stream, ingest: IngestDetails): MockRoute {
  return {
    method: 'POST',
    path: `/api/streams/${ID}/finish`,
    respond: () => jsonOk({ stream, ingest }),
  };
}

/** `makeIngest()`'s details once the key has changed to `publishKey`. */
function ingestWithKey(publishKey: string, publishKeyRotatedAt: string): IngestDetails {
  const before = makeIngest();
  return makeIngest({
    publishKey,
    publishKeyRotatedAt,
    srt: { url: before.srt!.url.replace(before.publishKey, publishKey), passphrase: before.srt!.passphrase },
  });
}

function calls(fetchMock: ReturnType<typeof mockFetch>, method: string, path: string): number {
  return fetchMock.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? 'GET') === method)
    .length;
}

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
