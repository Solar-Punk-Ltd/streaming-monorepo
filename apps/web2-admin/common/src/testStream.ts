import type { MediaType } from '@streaming-monorepo/contracts';

import type { StreamStatus } from './api.js';

/**
 * Test streams. A test stream is a stream of its own, marked as a test when it is created, for checking the devices,
 * the encoder and the path to a stage before an event. It goes live on its stage like any stream and is never on the
 * catalogue, so no viewer's list shows it. The team watches it on a deployed viewer whose address the stream holds,
 * from a link on its page in the console. `docs/architecture/test-streams.md` is the design.
 */

/** POST a {@link TestStreamInput}: creates a test stream, answered 201 with the `Stream`, whose `test` is true. */
export const TEST_STREAMS_PATH = '/api/streams/test';

/**
 * What a test stream is created from: a title, a media type and a stage. It takes no scheduled start, description,
 * tags or image, which are promises to viewers, and its row holds an empty description, no tags and no scheduled
 * start. The stage is one that takes streams, and any other is refused with 409 `stage_unavailable`, as for any
 * stream.
 */
export interface TestStreamInput {
  title: string;
  mediaType: MediaType;
  stageId: string;
}

/** The `error` code of the 409 a test stream answers an action it never takes with. */
export const TEST_STREAM_ERROR = 'test_stream';

/**
 * What a test stream refuses, each with 409 {@link TEST_STREAM_ERROR}:
 * - `publish`: publish, republish and unpublish. A test stream is never on the catalogue.
 * - `edit`: `PUT /api/streams/:id`. A test stream's title, media type and stage stay as it was created.
 * - `thumbnail`: setting an image. No viewer is shown a card for a test stream.
 * - `archive`: every archive route of the stream: the options, the start and the listing switch.
 *
 * Everything else a stream takes, a test stream takes: Rotate key, Finish, an export, and a delete whenever it is not
 * live, which a live one refuses with 409 `stream_live`. It alone takes a viewer address (`testStreamViewerUrlPath`).
 */
export type TestStreamRefusedAction = 'publish' | 'edit' | 'thumbnail' | 'archive';

/** The sentence each refusal carries as its `message`, which the console shows as it is. */
export const TEST_STREAM_REFUSALS: Record<TestStreamRefusedAction, string> = {
  publish: 'A test stream stays off the catalogue. Create a stream to publish one.',
  edit: 'A test stream stays as it was created. Delete it and create another to change it.',
  thumbnail: 'A test stream has no image: no viewer is shown a card for it.',
  archive: 'A test stream cannot be archived. Export it to keep its recording.',
};

/** The body of that 409. */
export interface TestStreamRefusal {
  error: typeof TEST_STREAM_ERROR;
  id: string;
  action: TestStreamRefusedAction;
  message: string;
}

/** How long a test stream is live before the console marks it as left running: an hour, in seconds. */
export const TEST_STREAM_LEFT_RUNNING_SECONDS = 60 * 60;

/** Whether a test stream has been live for longer than {@link TEST_STREAM_LEFT_RUNNING_SECONDS}. */
export function isTestLeftRunning(
  stream: { test: boolean; status: StreamStatus; liveSince?: string | null },
  now: Date,
): boolean {
  if (!stream.test || stream.status !== 'live' || !stream.liveSince) return false;
  return now.getTime() - new Date(stream.liveSince).getTime() > TEST_STREAM_LEFT_RUNNING_SECONDS * 1000;
}

/** What a watch page's address is built from. */
export interface WatchedStream {
  mediaType: MediaType;
  owner: string;
  topic: string;
}

/**
 * The route of a stream's watch page in a viewer, which the stack's viewer and stream-event-client share. A viewer
 * plays the stream at it whether or not its list holds the stream, which is how a test stream is watched.
 */
export function watchPagePath(stream: WatchedStream): string {
  return `#/watch/${stream.mediaType}/${stream.owner}/${stream.topic}`;
}

/**
 * The address of a stream's watch page on the viewer at `viewerUrl`, whatever that address holds: the address with the
 * watch page's route as its fragment. Its path and query stay as given, and a fragment it already has, such as the
 * `#/` of a viewer's own list, gives way to the route.
 */
export function watchPageUrl(viewerUrl: string, stream: WatchedStream): string {
  const route = watchPagePath(stream);
  const given = viewerUrl.trim();
  try {
    const url = new URL(given);
    url.hash = route;
    return url.href;
  } catch {
    return `${given.replace(/#.*$/, '')}${route}`;
  }
}

/**
 * A test stream's viewer. The team watches a test stream on a deployed viewer, such as the manager's "Watch a stream"
 * deployment, at any http or https address. Each test stream holds the address of its own viewer, `Stream.viewerUrl`,
 * null until someone gives it. A test stream's page shows, from its creation on:
 * - its encoder details, the stream key among them;
 * - what to deploy a viewer with in the manager, the same for every test stream: the catalogue's owner and topic,
 *   `PublicConfig.feed`, as the feed owner and the feed topic;
 * - the field for the viewer's address, to give and to change;
 * - once an address is given, "Watch test stream": a plain link to `watchPageUrl(stream.viewerUrl, stream)`, opened in
 *   a new tab.
 */

/**
 * PUT a {@link ViewerUrlInput}: sets, changes or clears a test stream's viewer address, answered with the `Stream` as
 * stored. It needs a session, as every stream route does, and is taken in every status the test stream has. A `url`
 * with a `viewerUrlProblem` is refused as 400 `validation_error` with that sentence, and a stream that is no test
 * stream answers 409 {@link NOT_TEST_STREAM_ERROR}. A set is audited as `stream.viewer_url.set`.
 */
export function testStreamViewerUrlPath(id: string): string {
  return `/api/streams/${id}/viewer-url`;
}

/** The address to store, as `storedViewerUrl` gives it. Null, or an empty one, clears it. */
export interface ViewerUrlInput {
  url: string | null;
}

/** The `error` code of the 409 a stream that is no test stream answers a viewer address with. */
export const NOT_TEST_STREAM_ERROR = 'not_test_stream';

/** The longest viewer address a test stream holds. */
export const VIEWER_URL_MAX = 2000;

/**
 * Why a value cannot be a test stream's viewer address, as a sentence the console shows, or null when it can. Any
 * address that starts with `http://` or `https://` and reads as a URL is one, such as `http://203.0.113.7:10004`,
 * `https://team.example.com/viewer` or an address copied from the viewer's own tab.
 */
export function viewerUrlProblem(value: string): string | null {
  const url = value.trim();
  if (url.length > VIEWER_URL_MAX) return `The viewer's address is at most ${VIEWER_URL_MAX} characters.`;
  if (!/^https?:\/\//i.test(url) || !readsAsUrl(url)) {
    return "The viewer's address starts with http:// or https://, such as http://203.0.113.7:10004.";
  }
  return null;
}

function readsAsUrl(value: string): boolean {
  try {
    return new URL(value).host !== '';
  } catch {
    return false;
  }
}

/** The address as a test stream stores it: as given, without the spaces around it. An empty one is stored as null. */
export function storedViewerUrl(value: string | null): string | null {
  const url = (value ?? '').trim();
  return url === '' ? null : url;
}
