# Test streams

A test stream is a stream for checking the devices, the encoder and the path to a stage before an
event. It goes live on a stage like any stream: the same encoder, the same transcoding, the same
nodes and the same upload to Swarm. The team watches it from a link on its page in the admin, on a deployed viewer
whose address the stream holds. It stays off the catalogue, so no viewer's list, card, search or preview shows it.

## What a test stream is

- **A stream of its own.** It is a row in the admin's streams, marked `test` when it is created,
  by the Test stream box on Create New Stream (`POST /api/streams/test`). The insert sets the mark
  and nothing changes it.
- **What it is created from.** A title, a media type and a stage. Its description is empty, which
  the table's check allows a test row alone (migration 033), and it has no tags, no scheduled start
  and no image: those are promises to viewers.
- **Its own topic, feeds and key**, as every stream has. An event and its test are two streams, so
  the event's recording holds the event alone. "Test this setup" on a stream's page opens the form
  with the box checked and that stream's stage filled in, and the two rows carry no link to each other.
- **What the encoder is given.** The stage's host, port and passphrase are the event's. The stream
  id and the key are the test's own, so the encoder's server line differs between the two.

## Its life

| Status  | When                                                                           |
| ------- | ------------------------------------------------------------------------------ |
| `draft` | From its creation until its first broadcast. Its encoder details show at once. |
| `live`  | The stage's uploader reported the broadcast.                                   |
| `vod`   | The uploader reported the end. The row holds the recording's place and length. |

A test stream goes from `draft` to `live` to `vod`, and from `vod` to `live` when its encoder comes
back. It is never `publishing` or `published`, which mean "on the catalogue". The restart window,
Finish and the key change at the window's end apply to it as to any stream. It is deleted whenever
it is not live.

## Off the catalogue

Three guards keep a test stream off the catalogue, each enough alone:

1. **The database.** The check `streams_test_off_catalogue` (migration 032) holds a test row to
   `draft`, `live` or `vod`, with no catalogue index, no publish time and no image.
2. **The rule that lists the rows on the feed** (`StreamRepository.listOnFeed`) leaves test rows
   out. The reconcile, the boot check and a catalogue move all build from it.
3. **The catalogue's writer** refuses a list that names a test stream's topic.

A test stream answers these actions with 409 `test_stream`, and the body names the action and
carries the sentence the console shows (`TestStreamRefusal` in `apps/web2-admin/common`):

| Action      | Routes                                                |
| ----------- | ----------------------------------------------------- |
| `publish`   | publish, republish and unpublish                      |
| `edit`      | `PUT /api/streams/:id`: the title, type and stage     |
| `thumbnail` | setting an image                                      |
| `archive`   | the archive options, the start and the listing switch |

It takes everything else a stream takes: Rotate key, Finish, an export of its recording into an MP4,
and a delete. It alone takes a viewer address.

## The uploader

The stage's uploader treats a test stream as any stream. The admin's side differs in three places.

- **Open as a draft.** One rule, `isOpenToUploader` in the backend's `streamState.ts`, says whether
  a stream is open to its stage's uploader. The lookup of an ingest id, the state reports and the
  quality reports all ask it. A stream is open while it is published, live or recorded. A test
  stream is open in every status it has, a draft included, as long as it has a stage.
- **Reports with no catalogue write.** A state report and a quality report of a test stream are
  stored, in the same serialised step a listed stream's are, and nothing is written to the
  catalogue. The state report's answer says `written: false`.
- **The order number.** The uploader orders the answers to its quality reports by `feed.index`, so
  an answer holding an older merge of the ladder never replaces a newer one. For a listed stream
  that number is the catalogue slot the report wrote. For a test stream it is the stream's order
  number, `report_order` on its row: it grows by one with every report the admin stores for that
  stream, in the statement that stores it. It orders the answers and names no catalogue slot.

A stage takes several broadcasts at once, and a test stream is taken whenever its encoder connects.
A test and another stream live on one stage share the stage's transcoding and upload, so the
console says it: an event's page shows that a test is live on its stage, by title, and a test's
page shows that another stream is live on its stage.

## Watching it: a link to a deployed viewer

The team watches a test stream on a deployed viewer built for this admin's catalogue, such as the
manager's "Watch a stream" deployment, the viewer page and a gateway node. Each test stream holds
the address of its own viewer.

- **What a viewer is deployed with.** The catalogue's owner as the feed owner and the catalogue's
  topic as the feed topic, both answered by `GET /api/config`. They are the same for every test
  stream. The page shows the owner with `0x` in front, as the manager's "Watch a stream" takes it.
  The viewer lists what the audience's viewer lists.
- **The address.** `viewer_url` on the stream's row (migration 033), `viewerUrl` on the `Stream`,
  null until given. It is any address that starts with `http://` or `https://` and reads as a URL
  (`viewerUrlProblem`): a host name or an IP address, with a port, a path or anything else it
  holds. It is stored as given.
- **Giving it.** `PUT /api/streams/:id/viewer-url` sets, changes and clears it, for anyone signed
  in, in every status the test stream has. Each set is audited as `stream.viewer_url.set`. A stream
  that is no test stream answers 409 `not_test_stream`.
- **The link.** The stream's watch address on that viewer is the address with the watch page's
  route, `#/watch/<mediatype>/<owner>/<topic>`, as its fragment (`watchPageUrl`). The address's
  path and query stay, and a fragment it already has gives way to the route, so an address copied
  from the viewer's own tab works. A viewer plays the stream at its watch address whether or not
  its list holds it.

A test stream's page opens when the stream is created and shows, from then on:

| Part                 | What it shows                                                                    |
| -------------------- | -------------------------------------------------------------------------------- |
| Encoder details      | the stage's host, port and passphrase, the stream id and the stream key          |
| Deploying a viewer   | the feed owner and the feed topic to deploy a viewer with in the manager         |
| The viewer's address | the field that gives and changes it                                              |
| "Watch test stream"  | once an address is given: a plain link to the watch address, opened in a new tab |

## Who can read a test stream

A test stream's segments, playlists, feeds and time markers are on Swarm unencrypted, as every
broadcast's are. Reading them takes the stage's address, which every catalogue entry of that stage
carries, and the test stream's topic, a random UUID that is in no list. Swarm cannot list the feeds
of an address. So a test stream is readable by whoever holds its watch address, on any viewer, and
the admin shows that address to its signed-in users alone.

## How it meets the rest

- **Stages.** Only the uploader of a test stream's own stage is answered about it.
- **A restart that waits for the stage.** The manager reads the stage's ingest and holds a restart
  while a broadcast is on it, so a test broadcast counts as live.
- **Lost recordings.** The one rule that says whether a check may judge a stream,
  `recordingSkipReason`, leaves a test stream out with the reason `test`. A check skips it and a
  removal leaves it.
- **Archives and exports.** An archive of a test stream is refused. An export is allowed: the team
  downloads a test's recording as an MP4.
- **Catalogue moves.** A move carries the catalogue's entries and their images. A test stream has
  neither.
- **Stamps.** A test spends its stage's quality stamps at the rate of a broadcast of the same
  length, and nothing of the catalogue's stamp. Its recording stays on Swarm until the stage's
  stamps run out.
- **The audit log.** Every action on a test stream is recorded as for any stream, and its rows
  carry `test: true` in their details.
- **A test left running.** The Streams page marks a test stream that has been live for more than an
  hour (`TEST_STREAM_LEFT_RUNNING_SECONDS`). A broadcast is stopped at the encoder or from the
  manager.
- **Who sees it.** Every signed-in user. The Streams page shows test streams with a "Test" mark and
  a filter.
