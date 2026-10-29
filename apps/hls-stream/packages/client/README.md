# Client

The client is the stack's viewer: a React app that lists the streams in the catalogue and plays them from Swarm. It is part of the [stack](../../), `apps/hls-stream`. This page is its README and its reference: settings, the node picker, the player's behaviour and its loaders.

## Prerequisites

- Node.js 24+
- pnpm
- A running Swarm Bee node (for reading streams)
- A running [stream uploader](../stream-uploader/) (for producing streams)

## Getting Started

From the stack's folder, `apps/hls-stream`:

```bash
# Install the whole workspace, from the root lockfile
pnpm install

# Create .env from sample (if not done yet)
cp .env.sample .env
# Edit .env, fill in VITE_APP_OWNER, VITE_READER_BEE_URL, etc.

# Start the dev server
pnpm client:start
```

Opens at `http://localhost:5173`.

The viewer and the uploader read one `.env` file, in the stack folder `apps/hls-stream`. Nothing reads a `.env` at the monorepo root. [.env.sample](../../.env.sample) lists every variable.

## Vite Dev Proxy

When `VITE_READER_BEE_URL` points to `localhost` or `127.0.0.1`, the dev server automatically proxies `/bee/*` requests to the Bee node. This avoids CORS issues during local development, no Bee configuration needed.

In production builds or when pointing to a remote gateway, requests go directly to the configured URL. Where each part reads from can also be changed at runtime via the UI (the Sources button in the header, `DomainSelector`), which also checks and tests every source and copies a report. See [The node picker](#the-node-picker).

## Environment Variables (in the stack's `.env`)

| Variable                     | Required | Description                                                                                                                                                                  |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_READER_BEE_URL`        | Yes      | Bee node URL for fetching streams                                                                                                                                            |
| `VITE_APP_OWNER`             | Yes      | Feed owner address (hex, no 0x prefix)                                                                                                                                       |
| `VITE_APP_RAW_TOPIC`         | Yes      | Feed topic for the stream catalogue, must match `STREAM_LIST_TOPIC`                                                                                                          |
| `VITE_SWARM_PROVIDERS`       | No       | The gateways the viewer reads, as JSON. Empty means the one gateway `VITE_READER_BEE_URL` names. See [The Swarm client](#the-swarm-client)                                   |
| `VITE_EXPOSE_PLAYER`         | No       | Test builds only. Puts the player, gateway and fetch-backend handles on `window` for the e2e browser suites. No shipping build sets it, and `bundle.test.ts` holds that line |
| `VITE_BROWSER_FETCH_BACKEND` | No       | Set to `weeb3` to fetch segment bytes from the in-tab node, see [weeb-3 runs in a SharedWorker](#weeb-3-runs-in-a-sharedworker). Unset means the gateway                     |

The dockerized client is also built with `VITE_APP_RELEASE_LABEL` and `VITE_APP_RELEASE_COMMIT`, the release
`deploy.sh` was told it deploys with `--release-label` and `--release-commit`, which the QoE overlay shows. They are not
`.env` settings: `deploy.sh` writes both for every client it builds, empty without the flags. See
[deploy/README.md](../../deploy/README.md#--release-label-and---release-commit).

## The build stamp

A deployed client serves `/build-stamp.json` beside `index.html`, recording which sources the bundle
was built from: `clientTree` and `sharedTree` are `git rev-parse HEAD:packages/client` and the same
for `packages/shared`, and `contractsTree` the same for the `packages/contracts` at the workspace
root that shared re-exports, empty where the checkout has no such package. Beside them sit the head
commit, whether the build came from uncommitted sources, when it was built, and the two Vite knobs
that decide what the bundle actually does. `deploy.sh`
mints the values from git and `deploy/Dockerfile.client` writes them into `dist/`, so nginx serves
the file off the filesystem with no configuration of its own.

It exists because nothing else can tell a stale client from a current one. The e2e suites
([e2e/README.md](../../e2e/README.md)) read this client's console lines to judge its behaviour.
The suites are synced to the deployment host on every run and this image is not rebuilt with them, so the client on the host and the suites can come from different sources without any sign.
The `client-shape` e2e preflight reads the stamp over HTTP and refuses to start a test run whose
served client was not built from the same checkout as the suites. A build whose args were never
passed writes empty hashes, which that check reads as a client built without a stamp and answers
with a redeploy.

## Features

- **Stream browser.** Reads the catalogue from its Swarm feed and lists every entry, live first, then
  newest first.
  - It reads the catalogue again once a minute (`CATALOG_POLL_INTERVAL_MS`). Each read asks for the
    feed's next slot before anyone has written it, and Bee skips every peer asked that early for a
    minute, so asking more often gains nothing. A new or changed entry reaches an open page up to a
    minute after it is written.
  - A read that fails is tried again after 5 seconds (`FIRST_LOAD_RETRY_MS`) until the list has been
    shown from the node selected now, on the first load and after a switch of node. After that a
    failed read waits the same minute. There is no growing backoff.
  - A read from a newer feed slot replaces the list whatever changed in it, so an entry edited,
    unpublished or gone live in place shows on an open page without a reload. When a read or the list
    on screen does not say which slot it came from, only a new newest entry replaces the list.
- **Stream preview.** The entry's uploaded `thumbnail` when it has one, otherwise a frame decoded from
  the stream's first segment, with live and upcoming badges and the duration.
  - A recording's entry carries its playlist's feed index, so its card reads that slot directly.
  - A live entry carries no index, so a live card finds its playlist through Bee's feed head lookup,
    which is slower.
- **Scheduled streams.** An entry whose `state` is `scheduled` has been announced but never broadcast,
  so nothing is written under its topic yet.
  - Its card shows the uploaded image or the placeholder and never asks for a manifest. Its watch page
    says the stream has not started instead of starting a player against a feed that does not exist.
  - While the entry is scheduled, the watch page reads the broadcast's ladder markers, each period's
    marker once, about 4 seconds into the period. Each marker found prompts one read of the catalogue,
    and the player starts with the stream's renditions once the catalogue says live.
  - Apart from that the page reads the catalogue once a minute, for a new start time, a title change
    or an unpublish, for the same reason as the stream browser.
  - If the stream is unpublished while the page waits, the page says it is no longer available and
    keeps reading the catalogue, so publishing it again reaches the page without a reload.
- **A broadcast that comes back.** In admin mode a declared stream's broadcaster can stop and later
  return to the same feeds, and the admin lists the stream as live again.
  - After a feed finishes, the player keeps asking for the slot after the finished playlist, about
    every 30 seconds (`FEED_RETURN_WATCH_INTERVAL_MS`), spread per viewer.
  - Once that slot holds an open playlist and the viewer has reached the end of what they were
    playing, the player rejoins the live broadcast. A viewer still watching the recording further back
    is not moved.
  - A broadcast that never comes back stays on "This broadcast has ended".
- **Coming back to the page.** A phone that locks pauses the video, and Safari on an iPhone does not
  start it again on unlock.
  - When the page is visible again on a live stream that is paused, playback starts again from where
    it stopped. Live plays at normal speed, so a short lock adds its length to how far behind live
    the viewer sits, and only past twice the target does hls.js jump them forward to it.
  - A pause the viewer made while watching, more than a second before the page was hidden, stays
    paused. A stream that is already playing is left to the player, and a recording is never touched.
  - A pause the viewer makes while the page is hidden, from the lock screen's controls, by taking out
    earphones or with a media key, is undone when the page comes back. The rule is in
    `resumeOnReturn.ts`.
- **HLS playback.** Video and audio through hls.js with custom loaders, see
  [Custom hls.js Loaders](#custom-hlsjs-loaders).
- **Sources.** The build's gateways plus any number of gateways and Bee nodes a viewer adds, read as
  one source or one per part, with the fallback order, a status dot and a Test for each, who answered
  each feature in the last minute, and a copyable report, all kept in localStorage. See
  [The node picker](#the-node-picker).

## The node picker

The Sources button in the header opens the picker (`src/components/DomainSelector/`). Every change in
it applies at once and is kept in this browser.

- **Sources.** The build's gateways, which cannot be renamed or removed, then the gateways and Bee nodes
  the viewer added, any number of each, each with a name of up to 40 characters, renamed and removed
  in the list (`src/swarm/sources.ts`). A source is added only once it passed its check below, and in
  One source mode it is in use at once.
- **One source or Per part** (`src/swarm/routing.ts`). One source reads the video, the stream list and
  the previews from the source whose radio is picked. Per part has a source for each of the three, and
  the video and the stream list are linked until the viewer unlinks them, because the player finds a
  live stream's newest entry from time markers at addresses computed from the clock of whoever serves
  the stream list, so the two on different hosts can put the player behind or ahead of live. A part
  whose source is removed reads from the default gateway.
- **The fallback order** (`src/swarm/fallbackOrder.ts`). One order for every part, the build's until the
  viewer moves a gateway up or down, with the default gateway always last. A saved order can reorder
  the gateways the build falls back to and never add one, and a part's own source is left out of its
  list.
- **A status dot per source** (`sourceStatus.ts`). While the picker is open every source is checked as
  it opens and again every 10 s: a gateway is asked for the stream list's first entry, a Bee node the
  probe below. Each source keeps one client while the picker stays open, so a gateway that refuses
  `/soc` is asked it once, and its later checks read the entry by its chunk address. The dot is green with the time the source took, amber with a word for one that answers and
  cannot serve (Starting, Busy, Limited, Errors), and red for one that does not answer or that the
  browser would block. Running a source's Test checks its dot again too.
- **What the browser keeps.** `swarm-sources` holds the added sources, `swarm-routing` the mode and each
  part's source, and `swarm-fallback-order` the viewer's order (`src/providers/sourceStorage.ts`). A
  browser that still holds a single saved address under the older key `swarm-gateway-url`, and none
  of the new keys, has it moved once on load: an offered gateway's address is a choice of that gateway,
  and any other becomes an added Bee node named My Bee node, in use. The old key is then removed. A
  browser that refuses the page its storage gets the build's defaults for that visit.

### Adding a source

A source is a gateway or a Bee node. Its address can be any address, a path on this site such as `/bee`
or an http or https address, because the picker is also how this viewer is pointed at a gateway under
test. A gateway typed without a scheme is taken as https and a Bee node as http. A gateway is checked by
its Test below, whose connection must pass, and its results then show under its row. A Bee node is
checked by its own probe (`gatewayProbe.ts`): its `/health`, its `/readiness` (400 while it starts), its `/peers` (503 while it
starts, none when it has no peers yet), and a version of at least 2.3.0, the release that added the
`GET /soc` every feed entry is read through. A node that answers but cannot serve yet is not added,
and the picker says to wait, or to update the node.

When nothing readable comes back, a second request with `mode: 'no-cors'` tells nothing at the address
apart from a node that answers and refuses this site, and the refusal shows the exact
`cors-allowed-origins` line for Bee's config file, its flag and its environment variable, for the origin
the page is served from. Where the browser has Local Network Access, read off the Permissions API, and
the node is on a more private network than the page, the picker says whether the viewer refused this
site that access, and explains the browser's question and how to undo a refusal in Chrome, Edge and
Firefox. A node that never answers while the browser has yet to ask that question gets the same
explanation rather than being called slow, because Chrome holds the request while it asks.

From an https page a plain http address is refused before anything is sent, because a browser blocks
it as mixed content, with two exceptions. A node on this computer is always asked. A node on the local
network (10/8, 172.16/12, 192.168/16, `.local` names, IPv6 unique local addresses) is asked in a
browser with Local Network Access, Chrome and Edge today, and every read of it is sent with
`targetAddressSpace: 'local'` (`src/swarm/addressSpace.ts`). In any other browser the picker says
which browsers can reach it. The local network is read from the address as written, so a name that
resolves to the local network, such as `bee.lan`, and a link-local address count as the internet.

## The node picker's tools

Beside the sources sit three debug tools (`GatewayTools.tsx`). They live only while the picker is open,
and closing it stops a test and a status check under way.

- **Test.** Every source has a Test
  that reads this deployment's real content through a client of that gateway alone, with no fallback
  behind it, each read given the 10 s the viewer's own read has (`providerTest.ts`). The connection of the
  viewer's own Bee node is the probe above, given 5 s, with the same help under a failure. A gateway the build offers serves only the
  stream's content and refuses `/health`, so its connection is shown by its content reads: any answer
  passes it, and when none came it says it did not answer in time or could not be reached. The stream
  list is its feed's head, checked to be a stream list. The video is read as the player starts: the
  ladder's time marker on a live ladder, a rung's entry the list names on any other ladder, and the
  feed head of a stream the list names no renditions for, a recording among them. Then one segment's
  URL is loaded. Previews read the playlist a stream card reads. Pictures load one stream's picture. The
  checks after the list use the stream this gateway listed, or the list the page already shows when
  it could not, a live stream first. This viewer has no chat, so there is no chat check. Each check
  ends in one sentence, and a failure says what the viewer can do: "this node does not allow this
  site" with the setting that decides it, or that this site's own policy does not allow the address,
  which a proxy in front of a deployment can set, "this address is not a Swarm gateway", or "the gateway did
  not answer in 10 s". The sentences are in `checkSentences.ts`, each with its test.
- **Status.** Who answered each feature in the last minute, from the client's `activity()`: which
  source the feature reads from and every fallback behind it in the order they are asked, how many answers of each kind came from
  each, how many came from the fallback, and which provider is paused and for how long
  (`providerStatus.ts`). It refreshes every 2 s while the picker is open. With the picker closed, the
  header's Sources button says "Using fallback" while the fallback answered a read of the video in the
  last minute, or the gateway in use is paused, so a viewer sees the switch without opening anything.
- **Report.** "Copy report" copies the last test's sentences, the status, the build and the browser
  (`report.ts`). It holds no address but the tested gateway's: every other provider is named, never
  addressed, and a test fails if another address or a source the viewer saved gets in. The build is the
  package, its version and when it was built, which `vite.config.js` writes in as `__BUILD_LABEL__`.
- **The image adds nothing for them.** The client image serves the page with no content security
  policy, so a gateway the build offers is reached as any other request is, and there is no gateway
  list to widen.

## QoE Overlay

Append `?qoe=1` to a stream watcher URL to enable a draggable overlay with playback quality metrics (startup time, rebuffering, bitrate, dropped frames, live latency, etc.). Press `Q` to toggle visibility.

The panel resizes like a desktop window, from every edge and corner, and the toggle button drags it
around. Its text keeps its size: a narrow panel wraps each row, the value under its label, and the
panel scrolls when the rows don't fit. It never gets smaller than 160 × 120 px. The panel and its
button stay inside the browser window's visible area, not the player's: they may hang over the page
outside the player, which an audio stream's player needs, a control bar too short to hold the panel.
It opens 250 × 800 px, with the button at the player's top right and the panel below it, shorter
where the window's bottom is nearer, and can be resized as tall as the window, less the button above
it. A window resize pulls the two back inside. A scroll does not, since the overlay is placed in the
player and scrolls with the page. The video's own fullscreen, from its native controls, shows the
video alone, without the overlay. With the panel hidden, the button drags on its own, anywhere in
the window. Shown again, the panel hangs from the button's corner, and the two are pulled back
inside the window together. The panel's size and place, relative to the player, are remembered in
this browser, under the localStorage key `swarm-hls.qoe-overlay.v1`, and restored on the next load,
pulled back inside the window (shrunk first, then moved) if they no longer fit. The geometry is in
`src/components/SwarmHlsPlayer/overlays/qoe/qoeGeometry.ts`.

Under its header the overlay names the release the player was built as, `Player QA-build-1 (1702aff1b)`: the
label the deploy named and the first nine characters of its commit, or the label alone when it already starts with
those nine or there is no commit, with the whole commit as the line's title. A build whose deploy named no release
shows no such line. The overlay is the only place the player shows it (`src/utils/playerRelease.ts`).

**Copy** and **Save** in the panel's header export what the panel shows, as JSON pretty-printed with two spaces: the
title, the release line as `player` when the panel shows one, every section and row in the panel's order, the ABR
ladder rows with their labels as shown, and the footer. Every value is the string the panel prints, rounding and all,
and nothing the panel does not show. The panel and the export are built by one function,
`overlays/qoe/qoeContent.ts`. Copy puts it on the clipboard. A browser refuses the clipboard to a page served over plain
http, so Copy then tries the older copy of a selection, and where that is refused too it says so. Save downloads the
same JSON as `qoe-<stream>-<YYYYMMDD-HHMMSS>.json`, the stream's topic made file-safe and the viewer's local time, and
works wherever the page is served. Without `?qoe=1` neither the overlay nor its buttons appear.

```json
{
  "title": "QoE Metrics",
  "player": "QA-build-1 (1702aff1b)",
  "sections": [{ "title": "Startup", "rows": [{ "label": "Startup Time", "value": "1234 ms" }] }],
  "footer": "Playback: 45678 ms"
}
```

## ABR ladder

A stream published with the SRS ABR ladder is **five feeds**: one media playlist per rung, plus a multivariant playlist, the master, on a feed of its own whose topic is the ladder's group id. The catalogue entry's `topic` points at the master, so one URL yields the whole ladder and any Swarm-aware HLS client can consume it, not just this player. The entry also keeps a `renditions` array (one per rung, with its measured bandwidth), which is what lets the UI describe a ladder without fetching anything. Once the ladder is a recording, the uploader's entry names only the rungs that recorded, and a rung whose stop failed is listed in `unfinishedRungs` instead. An entry the admin layer holds can still list such a rung with no index, so the watch page leaves out any rung with no index on a finished entry (`utils/playableRenditions.ts`).

When the catalogue entry names the stream's renditions, the loader builds the master from them and never reads the master feed, whose head lookup was the slowest read at start. A stream turns live once its first quality has reported, so a viewer who joins a moment before the others report gets an entry naming only some of them. It may also name none, when a page starts the player on the stream's first marker. The player compares the entry with the stream's time marker, the one it reads at the start anyway and then one per 10 second period for a minute, each address once. When a marker names a quality the entry lacks, the watch page reads the catalogue's next slot once. A quality reports before its first segment, so that slot is written by then and the read is not early. The fuller entry rebuilds the player with every quality, at the cost of a moment of loading. The page never polls the catalogue for this. Any other stream's feed decides what it is from what it answers with, not from a flag: a body containing `#EXT-X-STREAM-INF` is a master, and the rungs it names are registered before hls.js has parsed it.

Feed URIs use a `swarm://<owner>/<topic>` scheme. That is not cosmetic: hls.js resolves every playlist URI through url-toolkit against the playlist's own URL, and a URI with a scheme is the one case it returns untouched, a bare `owner/topic` comes back as `owner/owner/topic`.

Append `?level=<rung>` to a stream watcher URL to pin playback to one rung (`?level=720p`), which is how you tell a bad rung apart from a bad switch. Without it, hls.js's ABR chooses. A stream with no ladder ignores the parameter and plays its single rendition as before.

### Rungs share a timeline, and the viewer passes it through untouched

A playlist's `#EXT-X-MEDIA-SEQUENCE` says how its entries are numbered, and each entry has its own
`#EXT-X-PROGRAM-DATE-TIME`. Inside a broadcast, every rung derives its session-local sequence and
date-time from one shared anchor. A rung topic can outlive an uploader session, so the published media
sequence may also include an offset read from that rung's previous feed head. That offset keeps the
feed moving forwards and does not enter the dating. Every rung is transcoded from one source with
keyframes forced to the same timestamps, so the date-time still identifies the same media across
levels even when their feed histories gave them different published offsets. The full contract is in
[the uploader's concepts page](../stream-uploader/concepts.md#the-manifest-contract).

`ManifestStateManager` **passes both through exactly as the publisher wrote them**. It keeps the
headers of the first playlist a viewer ever reads, so its `EXT-X-MEDIA-SEQUENCE` stays the sequence of
the oldest segment that viewer holds for the whole session. It also re-emits each segment's own
date-time with that segment. Recomputing either per viewer would detach the playlist from its feed
history or from the media clock shared by the rungs.

A recording published before the uploader stamped its segments carries no date-time, and the viewer emits none for it rather than inventing one.

### Tuning

The player's built-in tuning, private to `SwarmHlsPlayer.tsx` and overridden key by key through the component's `hlsConfig` prop, carries the ABR settings, and the ones that differ from hls.js's own defaults do so for one reason: hls.js measures throughput as `bytes / (loading.end - loading.first)`, which over a CDN is a pipe and over Swarm is mostly retrieval latency. So the EWMA half-lives are lengthened well past the defaults to stop that noise becoming level flapping, and the startup bandwidth probe is off because what it measures here is not bandwidth. `abrBandWidthFactor`, `abrBandWidthUpFactor` and `maxStarvationDelay` are exposed at hls.js's defaults so they can be swept without editing the component.

- **The live target.** Three segments of the playlist's segment length, never under 12 seconds, and it moves when the playlist names a new length. At the event's 2 s segments the viewer sits 12 seconds behind live, and hls.js jumps them forward once they fall 24 seconds behind. A caller that sets `liveSyncDuration` through `hlsConfig` keeps that value, 12 included. A rung's progress bound keeps its own floor of 6 seconds (`rungPosition.ts`).
- **Normal speed.** Live plays at normal speed, always (`maxLiveSyncPlaybackRate: 1`), so a viewer who falls behind the target is never played fast to catch up. Each stall leaves them that much further behind, until twice the target, where hls.js jumps them forward to it. A speed the viewer picks from the native controls stays theirs.

Two settings are load-bearing rather than preferences, because without them the ladder cannot leave its bottom rung at all:

- **`capLevelToPlayerSize: false`.** hls.js caps ABR at the first rung reaching `max(playerWidth, playerHeight) × devicePixelRatio` and enforces it through `autoLevelCapping`, which ABR cannot exceed for any bandwidth. In a 420px-wide player at `devicePixelRatio` 1 that resolves to 640×360, pinned to 360p permanently, however fast Swarm is answering. The watch page is also laid out full-viewport-width for the same reason: so the top rungs are worth reaching, not merely reachable.
- **Start at the top rung, fall back on evidence.** `findBestLevel` only moves _up_ to a rung when `abrBandWidthUpFactor × bandwidthEstimate ≥ BANDWIDTH`, and the estimate moves only on fragments actually fetched. A viewer pulling 700 kbps segments measures roughly 700 kbps, concludes that is all it can afford, and never tries the rung that would have told it otherwise, the floor is self-fulfilling. So on `MANIFEST_PARSED` the player seeds the estimate at exactly what the top rung needs under the up-switch factor and sets `startLevel` to that rung. The whole ladder is then affordable from cold, and real fragments move the estimate from there: if Swarm keeps up it stays high, and if it does not the EWMA falls while the starvation path drops the level as the buffer drains. The cost is honest, the first fragment is a top-rung fragment, so a slow gateway pays a slower startup before the first down-switch.

### A rung that stops being produced

When one quality stops publishing and the others carry on, the player drops that rung rather than waiting on it. The player reads only the rung it plays (see `LadderFeedPoller` below), so a rung is judged by its own progress, never by comparing it with another, because the rungs' feeds drift apart without bound.

- **A switch to a rung that has clearly stopped is refused.** One whose newest playlist is finished while the playing rung is live, or whose newest segment sits more than 30 seconds behind the playing rung's, is dropped and the viewer stays where they are.
- **The playing rung is judged by its own progress.** Once it has had nothing new for 8 seconds, or finishes, the next lower rung is read for three of its segments, never under 6 seconds. If that one moves on, only the playing rung stopped, and the player moves to the sibling and drops the stopped one. If it does not, the broadcast paused or ended, the player says so and drops nothing.

- **The end.** The rungs of one broadcast finish moments apart, each as its upload drains. So when the playing rung finishes, the next lower one is watched for that whole bound rather than to its first new playlist: one that finishes inside them means the broadcast ended, and only one that carries on through them is moved to. A rung the player was moved to that finishes before hls.js has switched to it runs the same check.

There is no limit on how many rungs are dropped. A rung refused at a switch is dropped too, and the player keeps moving on until it is on a rung that moves. A broadcast ending cannot be read as every rung failing in turn, because a rung is dropped only while another is seen moving.

The rule is in `LadderFeedPoller.ts`, `rungPosition.ts` and `rungHealth.ts`. `MIN_LEVELS_TO_DROP_ONE` is 2 because the last rung standing is still the only thing a viewer can be offered, under the stalled overlay. The uploader keeps its own rule in `LadderLiveness` for what the master advertises, by segment lag and at most one rung at once. The two need not agree, because the player reads the master once at most, and not at all when the catalogue names the renditions.

A drop is not reversible. hls.js's `removeLevel` deletes the rung for the session, and hls.js has no call that puts a level back, so a viewer who lives through an outage stays on the remaining rungs until they reload. The player does not cap with `autoLevelCapping` instead, because that froze the player without recovering.

### A segment that will not load

When hls.js gives up on one of the three newest segments of a live playlist (segments already marked as gaps not counted), the player marks that segment `#EXT-X-GAP` in the playlist it serves hls.js and starts loading again from the playhead. hls.js gives up after its own retries with no other rung left to try, or at once on a segment it finds no media in. The video skips that segment's picture, about one segment long, instead of freezing or restarting the player, and every later reload of that playlist says the same. At most four segments of one stream are skipped this way in any five minutes, and a stream opened after another starts with all four. Past that, or for an older segment, a finished broadcast or a recording, the player handles the error as it always did: hls.js's own skip stands for a segment it gave up on, and a fatal network error restarts the player. While another rung is left, a segment that failed to load is tried there instead and nothing is marked.

hls.js skips a gap entry without building a loader for it, so a gap never reaches `CustomFragmentLoader`: it is fetched from neither the gateway nor weeb-3, and it has no request or settle line in the console log the shared package's `clientLog.ts` words. The failed load that led to it keeps its own lines, settled as the error it was, and the player adds one warning naming the segment it plays past. The `?qoe=1` overlay counts each skipped segment once, under Segments Skipped in its Reliability section, and not as a fatal error, a reconnect attempt or a failed start. The rule is in `liveSegmentGaps.ts`, the limits in `playerConfig.ts`.

Fragment loading is started by hand from `MANIFEST_PARSED` (`autoStartLoad: false`) so that seeding happens before the first level is chosen, rather than depending on which of two hls.js controllers registered for `MANIFEST_LOADED` first.

Combine with `?qoe=1` to watch what those settings do: the overlay's ABR section shows the selected rung, hls.js's live bandwidth estimate, and **switch latency**, the time from hls.js committing to a rung until the first fragment of it is buffered.

## The Swarm client

`src/swarm/` is the one layer that reads Swarm, plain TypeScript with no React, and it imports nothing
from the app's components, pages, providers or layouts. Everything else reads only through it: a test
fails on a source line outside it that builds a Bee URL, calls fetch, or makes a Bee client of its own,
and on an import of anything in it past the client's public surface, which is `client`, `answers`,
`provider`, `settings` and `createSwarmClient` (`test/swarm/boundary.test.ts`). A provider's own files
and the registry of kinds stay behind it, so a new kind of provider changes nothing outside
`src/swarm`.

- **Where each feature reads.** `providers/App.tsx` makes one client at start from the build's
  gateways and the viewer's saved node, and makes it again when the viewer picks another node. The
  player reads through `reader('player')`, the stream list through `reader('stream-list')`, the
  previews and pictures through `reader('previews')`, and the node picker checks a node through the
  `probe()` of a client made for that node alone. This viewer has no chat, so there is no chat reader.
- **A provider** is one way of reaching Swarm (`src/swarm/provider.ts`), holding only what the app
  reads: a feed's head, a feed entry by index, a single-owner chunk's payload by its owner and
  identifier (a feed entry is one, and so is a ladder's time marker), a chunk, the bytes a reference
  names, and a URL for what the browser or hls.js loads itself. It also says what it can do, its
  status, a probe, and start and stop for a node in the tab. `src/swarm/providers/bee-http/` is Bee's
  HTTP API, asking the paths the viewer has always asked.
- **Every read answers and never throws** (`src/swarm/answers.ts`): the content, with the feed index
  and the server time where the answer carries them, not found, rate limited with the wait asked for,
  unsupported, unavailable with its cause (a timeout, a status or no answer at all), or aborted. Every
  read takes a signal and a window, ten seconds when none is given. Bee's 404 is not found, its 429 is
  rate limited with its `Retry-After` capped at a minute, and any other failing status, a 500 included,
  is unavailable. A chunk read is the exception: Bee answers 500 for a chunk nobody has written, so
  there a 500 is not found and never pauses the node.
- **A gateway that refuses `/soc`.** Public gateways answer `/soc` with a plain-text 404 from their
  front door, before Bee sees the request, and serve the same entry at `/chunks/<keccak256(id, owner)>`.
  A 404 on `/soc` whose body is not Bee's JSON error reads the chunk by its address instead. It is
  checked to be the owner's by its signature, and joined from `/bytes` when its body is longer than one
  chunk. The provider then goes to the chunk address first, until that route is refused too. Bee's own
  JSON 404 stays not found with no extra request (`src/swarm/singleOwnerChunk.ts`).
- **The client** (`src/swarm/client.ts`) is made from the settings and the viewer's choice by
  `createSwarmClient`, which makes each gateway's provider through the registry of kinds
  (`src/swarm/registry.ts`). Each feature reads through its own provider with an ordered list of
  fallbacks behind it, asked in turn until one answers, its own provider left out of the list.
  A provider that faults three times in a row is left alone for 15 seconds, twice that each time it
  faults again at once, up to two minutes, and a rate-limited one for as long as it asked. A paused
  provider is still asked when nothing else can be, and each fallback is paused on its own faults, so a
  paused one is skipped for the next. A read's window covers the fallbacks too: each gets only what the
  providers before it left, and none is asked once nothing is left. Every
  read is counted by feature, kind, provider and answer, and `activity()` says what each feature read
  in the last minute, from whom and how many answers came from the fallback. The server time of the
  player's and the stream list's answers keeps the gateway clock the time markers are read on, and no
  other feature's moves it.
- **URLs follow the provider serving now.** A reader's `urlFor` takes URLs from the first provider
  that is not paused and gives URLs, and `urlSource` names it. A playlist the player already holds is
  served again with its segment lines named by that provider, so a pause that sends segments to the
  fallback, and the end of it, reach a playlist held from before (`ManifestManagement.ts`).
  - A recording's playlist is read only once, so hls.js keeps the segment URLs it was first given. The
    fragment loader therefore names each segment the player named again by the provider serving now,
    just before the request goes out (`ManifestFetcher.segmentUrlNow`). A viewer who switches node, or
    whose node is paused, while watching a recording gets the next segment from the new one.
  - A URL the player did not name goes out as given: a preview's segment, and an old recording whose
    manifest names its publisher's gateway.
- **What the node picker's Test uses.** `probe()` asks the provider every feature reads from first
  whether it is there, and `loadUrl` (`src/swarm/urlLoad.ts`) loads a URL the client gave, as the
  browser or hls.js would, and answers as a read does. The player and the pages never call it.
- **The in-tab node is unchanged.** Segment lines are the player reader's URLs, which for a Bee
  gateway are `<gateway>/bytes/<reference>`, so the fragment loader still finds the reference in each
  and hands it to weeb-3 when that backend is selected.
- **The settings come from the build**, as every other setting of this viewer does, not from a
  `config.json` beside the page. `VITE_SWARM_PROVIDERS` is JSON naming the gateways offered, each
  with an `id`, the `kind` `bee-http`, an optional `label` and a `url` that is a path on this site
  such as `/bee` or an http or https address, then the `default` gateway's id, an optional `fallback`,
  one id or an ordered list of them, and optionally the `kinds` a viewer may add a node of. The default
  gateway is always asked last, so a list may not name it, and without a `fallback` the default gateway
  alone is the fallback. A viewer who picked another gateway or a node of their own always has the
  build's own behind them, and a viewer on a fallback has the rest of the list behind them.
  `"fallback": false` switches it off. A build that leaves the setting empty reads the one gateway
  `VITE_READER_BEE_URL` names, the default and the fallback, so a deployment needs no change.
  A value that is wrong stops the page at start and says where (`src/swarm/settings.ts`). Every source
  a viewer reads from has the build's fallback order behind it.
- **The measurement switch.** A build made with `VITE_EXPOSE_PLAYER` puts a gateway switch on `window`
  (`src/providers/gatewayTestHandle.ts`). Its `select` reads every part from one source at the address
  given, the source that already has it or a Bee node added for it, and its `current` answers the
  video's source's address. An address a test writes to localStorage under `swarm-gateway-url` before
  the page loads is moved into a source on that first load, so a test that compares gateways starts
  each gateway in a fresh browser context with its address already set.
- **The contract** (`test/swarm/providerContract.ts`) is the suite every provider kind must pass, run
  for Bee over HTTP against a gateway held in memory (`test/helpers/fakeBeeGateway.ts`).

## Custom hls.js Loaders

Standard hls.js expects static manifest URLs. On Swarm, every manifest update produces a new content hash. The client solves this with custom loaders:

1. **CustomManifestLoader.** Instead of fetching a static URL, it hands hls.js's playlist requests to the `ManifestFetcher`. The top-level playlist is built from the stream list when the list names the renditions, and is otherwise the source feed's head. A single-rendition stream is then followed by reading its next slots by number, and a rung of a ladder by `LadderFeedPoller` (item 4), which never uses Bee's feed lookup.
2. **CustomFragmentLoader.** Resolves segment references from the manifest (which contain Swarm hashes) into fetchable URLs, the ones the Swarm client's player reader gives.
3. **ManifestStateManager.** Merges incoming live manifests into a growing EVENT-type playlist so segments remain available longer than the sliding window. Tracks feed indices, handles deduplication, and caches serialized output.
4. **LadderFeedPoller.** For ABR streams, owns the feed walk of the rung hls.js plays, plus the one being switched to while a switch is under way. See [Following a rung's feed](#following-a-rungs-feed).
5. **`fragmentRequested` and `fragmentSettled` are a parsed contract, not debug output.** The loaders write those two console lines, `packages/shared/src/clientLog.ts` composes them and owns their wording, and `e2e/src/browser/fragmentRequests.ts` reads them back. They are the only thing that lets an e2e test run say whether a down-switch the player asked for completed or starved. Rewording either one throws nothing and fails nothing. The e2e quality check then reads no lines at all, and the run reports on a viewer it could not see.

### Following a rung's feed

Every rung of the ladder is registered with `LadderFeedPoller`, and it reads only the rung hls.js plays and, during a switch, the one being switched to. A rung left behind forgets where it was, so coming back to it starts at its newest playlist.

- **Its parts.** Where a walk starts comes from a `NewestIndexFinder`, injected so it can be swapped: the `MarkerFinder`, which reads the ladder's time marker and falls back to the `IndexSearchFinder`. How it follows is `followPredicted` in `SwarmHlsPlayer/following/`.
- **Why `followPredicted`.** A simulation in `test/feedModel/`, a model of a Bee node, a publisher and a player, compares it with other ways of polling a feed. `followPredicted` is the one it recommends.
- **Segment length.** The player assumes none. The follower and the searches take it from the `#EXTINF` values of the playlist they stand on, and a join from a time marker takes the `segmentMs` the marker names, which is the stage's `HLS_FRAGMENT`.
- **How it times its reads.** The player asks for the next playlist when it is due: the newest segment's end, plus one segment, plus a delay it learns from its own reads, set so that about one ask in four comes too early. A second ask covers that one, then one ask per segment, then asks every 2 seconds rising to 4 while nothing comes. A playlist 4 seconds late is looked past, one slot further on.
- **When the broadcast goes quiet.** Bee skips, for a minute, every peer it asked for an address not written yet, so a slot asked for over and over during an outage stays unreadable for about a minute after the broadcaster is back.
  - Once the next slot has had five asks, the player stops asking for it and reads the ladder's time markers instead (next item), each one once, 4 seconds into its 10 seconds.
  - When a marker names a slot past the missing one, the player reads that slot, whose playlist also holds the segments it skips, and follows on from there.
  - The picture is back 4 to 14 seconds after the broadcaster has new video, rather than about a minute. In a 10 second period whose marker is missing, the slot itself is asked once.
- **How it finds the newest playlist.** It reads slots by their number, never Bee's feed lookup.
  - The uploader writes a time marker for each ladder every 10 seconds, at an address worked out from the clock, naming every rung's newest playlist (`packages/shared/src/ladderMarker.ts`).
  - At the start, at a switch, and when a rung stops or finishes, the player reads the marker of the previous 10 seconds, and the one before if that is missing, then one round of eight slots from where it says. One marker read serves every rung for a few seconds, and a marker address found missing is never asked again.
  - The clock is the gateway's, taken from the `Date` header of every answer the Swarm client reads, so a viewer whose clock is wrong still finds the marker. A gateway on another origin has to list `Date` in `Access-Control-Expose-Headers` for the browser to show it, and without that the correction stays zero.
  - With no marker, it searches. At the start it reads eight slots at once, spread out to the feed's length, closing in on the newest in a few rounds. At a switch it starts from the playing rung's newest slot, usually one round. The new rung is read further back when the viewer is behind the live edge, at most ten reads.
- **A quality's first playlist** is waited for 20 s, the poller's 15 s search and 5 s more, and then
  that quality is failed so hls.js tries another, because a gateway that does not hold a quality never
  answers for it.
- **A slow source.** The `ManifestFetcher` times how long the source it reads from takes to answer that
  a slot is not there, over the latest 16 such answers (`SwarmHlsPlayer/sourceMissCost.ts`).
  - From five answers on, the source is slow when the middle one of them is over 3 s. Before that it is
    slow when at least two answers were all over 3 s, so one slow first answer on a cold connection
    does not mark a fast gateway slow. A freshly started light Bee node with no blockchain took 6 to
    10 s, where a full node takes 1.3 to 1.6 s.
  - On a slow source a search round is taken to last one and a half of those answers. A read is given
    two rounds instead of the usual 10 s, and a quality's first playlist is waited for eight rounds and
    5 s more instead of 20 s, both capped, at 30 s and at about two minutes.
  - The player keeps reading from the source picked for it and never switches to another, and it makes
    no read more often than before. Until the first picture it says "This Swarm source answers slowly,
    so the video takes longer to start". On a source that is not slow nothing changes.

## weeb-3 runs in a SharedWorker

Built with `VITE_BROWSER_FETCH_BACKEND=weeb3`, the client fetches segment bytes from a Swarm node
running in the viewer's own tab instead of from a Bee gateway. That node is **not in the page**. In
`@lat-murmeldjur/weeb_3` the `Weeb3No103` class is a facade with no node behind it, and every call it
makes, `retrieveBytes` included, is passed to a SharedWorker. **There is no in-page mode
to fall back to**, so if the worker cannot start, a viewer on this backend gets no Swarm at all and the
only symptom is `the in-tab node did not reach the network: SharedWorker request timed out`.

A SharedWorker script has to come from the page's own origin, so the client serves the package's
runtime itself. Five things go into one directory, because they resolve relative to each other:

| Served as                | What it is                                                                       |
| ------------------------ | -------------------------------------------------------------------------------- |
| `/weeb-3/worker.js`      | The worker script. `Weeb3FetchBackend` passes this URL explicitly                |
| `/weeb-3/weeb_3.js`      | The wasm-bindgen glue, which `worker.js` imports                                 |
| `/weeb-3/weeb_3_bg.wasm` | The node itself, several megabytes of wasm, which the glue fetches beside itself |
| `/weeb-3/snippets/**`    | Two files the glue imports by relative path                                      |
| `/weeb-3/service.js`     | A ServiceWorker the glue registers at boot, scoped to `/weeb-3/`                 |

`scripts/copy-weeb3-runtime.mjs` copies them out of `node_modules` into `public/weeb-3/`, which Vite
copies verbatim into `dist/`. It runs from `prebuild` and `predev`, so a plain `pnpm build` or
`pnpm dev` is enough. The directory is generated and gitignored: the lockfile is the only thing that
says which version a deployment serves, and the copy refuses rather than serving a partial runtime if
a release stops shipping one of the five.

In production `deploy/client-nginx.conf.template` answers `/weeb-3/` off the filesystem with
`try_files $uri =404`. That block is load-bearing. Without it the prefix inherits the SPA fallback,
`worker.js` comes back as the app's own HTML at 200, and the failure surfaces as the timeout above
rather than as a missing file. The nginx image already maps `application/wasm`, which the glue needs
for `WebAssembly.instantiateStreaming`.

The worker URL is origin-absolute, so a deployment under a sub-path has to serve `/weeb-3/` at the
domain root as well.

`/weeb-3/service.js` is served even though this client never calls `attachStream`, the only thing
that uses the `/bzz/` routes it intercepts. The glue registers it the moment the node starts, so a
site without it logs a failed ServiceWorker registration at 404 on every page load. Its scope is
`/weeb-3/`, which keeps it away from every request this app makes.

That registration also means **the in-tab node only boots in a secure context**: https, or a
loopback host such as `localhost`. On a plain-http page reached by IP or hostname
`navigator.serviceWorker` does not exist, and the node dies at boot with `could not install
ServiceWorker relay listener` before it reaches any peer. A deployment that wants viewers on the
in-tab backend serves the client over https. The e2e browser tests, which reach a stage over plain http,
launch Chrome with `--unsafely-treat-insecure-origin-as-secure` for that one origin instead.

## Project Structure

```
src/
  components/
    Button/               # Reusable button (primary/secondary variants)
    DomainSelector/       # Gateway URL modal, and its Test, status rows and report
    Icons/                # SVG icon components
    StreamList/           # Stream list display (every entry, sorted)
    StreamPreview/        # Preview card with thumbnail
    SwarmHlsPlayer/       # Core player + custom loaders + manifest state
  layouts/
    Main/                 # Header + content wrapper
  pages/
    StreamBrowser/        # Home, fetches stream catalog, renders list
    StreamWatcher/        # Watch, plays a single stream
  providers/
    App.tsx               # Global state (stream list, gateway URL, the Swarm client)
    catalogPoll.ts        # How often a page reads the catalog again, once a minute
    catalogState.ts       # One catalog read, carrying the gateway it went to
    gatewayTestHandle.ts  # Where an e2e test finds the gateway switch
    sourceStorage.ts      # A viewer's sources, routing and fallback order, kept in localStorage
    useCatalogPoll.ts     # The hook that polls the catalog and hands each answer to the stream list
  swarm/                  # The one layer that reads Swarm: answers, providers, the client, settings
  types/
    stream.ts             # MediaType, StreamState, Stream interface
  utils/
    buildLabel.ts         # The build this page is, as the node picker's report names it
    catalogFeed.ts        # Follows the stream catalog feed by walking slots
    catalogList.ts        # Validates one catalog poll and works out the stream list it leaves
    config.ts             # Environment config with auto proxy detection
    fetchTimeoutError.ts  # The error a read whose window ran out reaches the player and the stream list as
    format.ts             # formatDuration (mm:ss)
    gatewayClock.ts       # How far the gateway's clock is from the viewer's, from the HTTP Date header
    playableRenditions.ts # The rungs of a catalog entry a viewer can be handed
    playerRelease.ts      # The release label and commit the QoE overlay shows
    requestJitter.ts      # Gateway request jitter, to desynchronise pollers
    scheduledStart.ts     # An announced broadcast's start time, in the viewer's own locale
    thumbnailManifest.ts  # A stream card's playlist read and its segment's URL
    watchPageView.ts      # What the watch page shows: loading, not started, unavailable or the player
```
