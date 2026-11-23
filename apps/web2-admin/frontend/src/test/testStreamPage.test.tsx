import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Stream } from '@streaming-monorepo/web2-admin-common';

import { StreamDetailsPage } from '../pages/StreamDetailsPage';
import {
  MAIN_STAGE_ID,
  jsonError,
  jsonOk,
  makeIngest,
  makeStream,
  minutesAgo,
  mockFetch,
  type Route as MockRoute,
  renderWithProviders,
} from './helpers';

const ID = 'test-stream-under-test';
const OWNER = '1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c';
const TOPIC = '00000009-0000-4000-8000-000000000000';
const CATALOGUE_OWNER = '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
const CATALOGUE_TOPIC = 'brand-catalogue';
const VIEWER = 'http://203.0.113.7:10004';

function testStream(overrides: Partial<Stream> = {}): Stream {
  return makeStream({
    id: ID,
    owner: OWNER,
    topic: TOPIC,
    title: 'Soundcheck',
    description: '',
    scheduledStartTime: null,
    test: true,
    stageId: MAIN_STAGE_ID,
    ...overrides,
  });
}

interface Served {
  stream: Stream;
  others?: Stream[];
  extra?: MockRoute[];
}

function routesFor({ stream, others = [], extra = [] }: Served): MockRoute[] {
  return [
    ...extra,
    { path: `/api/streams/${ID}`, respond: () => jsonOk(stream) },
    { path: `/api/streams/${ID}/ingest`, respond: () => jsonOk(makeIngest()) },
    { path: '/api/streams', respond: () => jsonOk({ streams: [stream, ...others] }) },
    {
      path: '/api/config',
      respond: () =>
        jsonOk({ feed: { owner: CATALOGUE_OWNER, topic: CATALOGUE_TOPIC, topicHex: 'ff' }, viewerBaseUrl: null }),
    },
  ];
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/streams/:id" element={<StreamDetailsPage />} />
      <Route path="/create" element={<Where />} />
    </Routes>,
    { route: `/streams/${ID}` },
  );
}

const addressField = () => screen.getByRole('textbox', { name: 'Viewer address' });
const watchLink = () => screen.queryByRole('link', { name: /Watch test stream/ });

describe('a test stream page', () => {
  it('shows the encoder details, the two values to deploy a viewer with, and an empty address with no link', async () => {
    mockFetch(routesFor({ stream: testStream() }));
    renderPage();

    expect(await screen.findByText('OBS connection details')).toBeInTheDocument();
    expect(await screen.findByLabelText('SRT Server')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();

    const deploy = screen.getByRole('region', { name: 'Deploying a viewer' });
    await waitFor(() => expect(within(deploy).getByLabelText('Feed owner')).toHaveValue(CATALOGUE_OWNER));
    expect(within(deploy).getByLabelText('Feed topic')).toHaveValue(CATALOGUE_TOPIC);

    expect(addressField()).toHaveValue('');
    expect(watchLink()).not.toBeInTheDocument();
  });

  it('shows the address it holds and "Watch test stream" as a plain link to the stream on that viewer, in a new tab', async () => {
    mockFetch(routesFor({ stream: testStream({ viewerUrl: VIEWER }) }));
    renderPage();

    const link = await screen.findByRole('link', { name: /Watch test stream/ });
    expect(link).toHaveAttribute('href', `${VIEWER}/#/watch/video/${OWNER}/${TOPIC}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(addressField()).toHaveValue(VIEWER);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it.each([
    ['a video stream', 'video', VIEWER, `${VIEWER}/#/watch/video/${OWNER}/${TOPIC}`],
    ['an audio stream', 'audio', VIEWER, `${VIEWER}/#/watch/audio/${OWNER}/${TOPIC}`],
    [
      'an address with a port, a path and a fragment',
      'video',
      'https://team.example.com:8443/viewer/?build=7#/',
      `https://team.example.com:8443/viewer/?build=7#/watch/video/${OWNER}/${TOPIC}`,
    ],
  ] as const)('links %s to its watch page on the viewer', async (_, mediaType, viewerUrl, href) => {
    mockFetch(routesFor({ stream: testStream({ mediaType, viewerUrl }) }));
    renderPage();

    expect(await screen.findByRole('link', { name: /Watch test stream/ })).toHaveAttribute('href', href);
  });

  it('gives the address from the page, and then shows the link', async () => {
    let sent: unknown = null;
    const fetchMock = mockFetch(
      routesFor({
        stream: testStream(),
        extra: [
          {
            method: 'PUT',
            path: `/api/streams/${ID}/viewer-url`,
            respond: (init) => {
              sent = JSON.parse(String(init?.body));
              return jsonOk(testStream({ viewerUrl: VIEWER }));
            },
          },
        ],
      }),
    );
    renderPage();

    await screen.findByText('OBS connection details');
    fireEvent.change(addressField(), { target: { value: `  ${VIEWER}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));

    expect(await screen.findByRole('link', { name: /Watch test stream/ })).toHaveAttribute(
      'href',
      `${VIEWER}/#/watch/video/${OWNER}/${TOPIC}`,
    );
    expect(sent).toEqual({ url: VIEWER });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  it('changes the address it holds', async () => {
    const changed = 'https://viewer.example.org/team';
    let sent: unknown = null;
    mockFetch(
      routesFor({
        stream: testStream({ viewerUrl: VIEWER }),
        extra: [
          {
            method: 'PUT',
            path: `/api/streams/${ID}/viewer-url`,
            respond: (init) => {
              sent = JSON.parse(String(init?.body));
              return jsonOk(testStream({ viewerUrl: changed }));
            },
          },
        ],
      }),
    );
    renderPage();

    await screen.findByRole('link', { name: /Watch test stream/ });
    fireEvent.change(addressField(), { target: { value: changed } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));

    await waitFor(() => expect(watchLink()).toHaveAttribute('href', `${changed}#/watch/video/${OWNER}/${TOPIC}`));
    expect(sent).toEqual({ url: changed });
  });

  it('clears the address it holds, and the link goes', async () => {
    let sent: unknown = null;
    mockFetch(
      routesFor({
        stream: testStream({ viewerUrl: VIEWER }),
        extra: [
          {
            method: 'PUT',
            path: `/api/streams/${ID}/viewer-url`,
            respond: (init) => {
              sent = JSON.parse(String(init?.body));
              return jsonOk(testStream({ viewerUrl: null }));
            },
          },
        ],
      }),
    );
    renderPage();

    await screen.findByRole('link', { name: /Watch test stream/ });
    fireEvent.click(screen.getByRole('button', { name: 'Clear address' }));

    await waitFor(() => expect(watchLink()).not.toBeInTheDocument());
    expect(sent).toEqual({ url: null });
    expect(addressField()).toHaveValue('');
  });

  it('says why an address is refused before sending it, and sends nothing', async () => {
    const fetchMock = mockFetch(routesFor({ stream: testStream() }));
    renderPage();

    await screen.findByText('OBS connection details');
    fireEvent.change(addressField(), { target: { value: 'ftp://203.0.113.7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));

    expect(
      await screen.findByText(
        "The viewer's address starts with http:// or https://, such as http://203.0.113.7:10004.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    expect(watchLink()).not.toBeInTheDocument();
  });

  it('shows the sentence the API refuses an address with', async () => {
    const refusal = "The viewer's address is at most 2000 characters.";
    mockFetch(
      routesFor({
        stream: testStream(),
        extra: [
          {
            method: 'PUT',
            path: `/api/streams/${ID}/viewer-url`,
            respond: () => jsonError(400, { error: 'validation_error', message: refusal }),
          },
        ],
      }),
    );
    renderPage();

    await screen.findByText('OBS connection details');
    fireEvent.change(addressField(), { target: { value: VIEWER } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(watchLink()).not.toBeInTheDocument();
  });

  it.each(['draft', 'live', 'vod'] as const)(
    'offers no Publish, no Archive, no image and no Edit on a %s test stream',
    async (status) => {
      mockFetch(
        routesFor({
          stream: testStream({
            status,
            liveSince: status === 'draft' ? null : minutesAgo(20),
            endedAt: status === 'vod' ? minutesAgo(5) : null,
            manifestIndex: status === 'vod' ? 3 : null,
          }),
        }),
      );
      renderPage();

      await screen.findByText('OBS connection details');
      await screen.findByRole('region', { name: 'Deploying a viewer' });
      expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Unpublish/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Archive/)).not.toBeInTheDocument();
      expect(screen.queryByText('No thumbnail')).not.toBeInTheDocument();
      expect(screen.queryByText('Thumbnail reference')).not.toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Test this setup' })).not.toBeInTheDocument();
    },
  );

  it('says another stream is live on its stage, by title, as information', async () => {
    mockFetch(
      routesFor({
        stream: testStream({ status: 'live', liveSince: minutesAgo(10) }),
        others: [
          makeStream({ title: 'Opening night', status: 'live', stageId: MAIN_STAGE_ID, liveSince: minutesAgo(30) }),
          makeStream({ title: 'Elsewhere', status: 'live', stageId: 'another-stage' }),
          makeStream({ title: 'Recorded one', status: 'vod', stageId: MAIN_STAGE_ID }),
        ],
      }),
    );
    renderPage();

    const note = await screen.findByText(/Another stream is live on this stage/);
    expect(note).toHaveTextContent('Opening night');
    expect(note).not.toHaveTextContent('Elsewhere');
    expect(note).not.toHaveTextContent('Recorded one');
  });

  it('says nothing of a shared stage while it is the only stream live on it', async () => {
    mockFetch(
      routesFor({
        stream: testStream({ status: 'live', liveSince: minutesAgo(10) }),
        others: [makeStream({ title: 'Elsewhere', status: 'live', stageId: 'another-stage' })],
      }),
    );
    renderPage();

    await screen.findByRole('region', { name: 'Deploying a viewer' });
    await screen.findByText('Test live · 10 min');
    expect(screen.queryByText(/is live on this stage/)).not.toBeInTheDocument();
  });

  it('shows how long it has been live, and marks it after an hour', async () => {
    mockFetch(routesFor({ stream: testStream({ status: 'live', liveSince: minutesAgo(75) }) }));
    renderPage();

    expect(await screen.findByText('Test live · 1 h 15 min')).toBeInTheDocument();
    expect(screen.getByText('Left running')).toBeInTheDocument();
  });
});

describe('an event stream page', () => {
  it('says a test is live on its stage, by title, as information', async () => {
    mockFetch(
      routesFor({
        stream: makeStream({ id: ID, title: 'Opening night', status: 'published', stageId: MAIN_STAGE_ID }),
        others: [
          testStream({ id: 'the-test', title: 'Soundcheck', status: 'live', liveSince: minutesAgo(10) }),
          testStream({ id: 'old-test', title: 'Yesterday', status: 'vod' }),
          testStream({ id: 'far-test', title: 'Elsewhere', status: 'live', stageId: 'another-stage' }),
        ],
      }),
    );
    renderPage();

    const note = await screen.findByText(/A test stream is live on this stage/);
    expect(note).toHaveTextContent('Soundcheck');
    expect(note).not.toHaveTextContent('Yesterday');
    expect(note).not.toHaveTextContent('Elsewhere');
    // Information only: the event's own actions stay as they are.
    expect(screen.getByRole('button', { name: 'Republish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeEnabled();
  });

  it('says nothing of a test while none is live on its stage', async () => {
    mockFetch(
      routesFor({
        stream: makeStream({ id: ID, title: 'Opening night', status: 'published', stageId: MAIN_STAGE_ID }),
        others: [testStream({ id: 'old-test', title: 'Yesterday', status: 'vod' })],
      }),
    );
    renderPage();

    await screen.findByText('OBS connection details');
    expect(screen.queryByText(/A test stream is live on this stage/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Deploying a viewer' })).not.toBeInTheDocument();
  });

  it.each(['video', 'audio'] as const)(
    'opens "Test this setup" on a %s stream as the new test stream form with its stage alone',
    async (mediaType) => {
      mockFetch(
        routesFor({
          stream: makeStream({ id: ID, mediaType, status: 'published', stageId: MAIN_STAGE_ID }),
        }),
      );
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Test this setup' }));

      // The form offers no media type, as the stream form offers none, so nothing carries one there.
      expect(screen.getByTestId('where').textContent).toBe(`/create?test=1&stageId=${MAIN_STAGE_ID}`);
    },
  );
});
