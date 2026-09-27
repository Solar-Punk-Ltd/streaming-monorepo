# swarm-hls-stream + msrs-uploader research (agent report, 2026-09-11). Repo: scratchpad/repos/swarm-hls-stream ($R). Branch refs via `git show origin/<branch>:<path>`.

## Branch state (critical)
main (bbfb8bf) is ~324-340 commits behind feature branches. No auth, no ABR, no zod on main. streaming-infra-manager pins swarm-hls-stream submodule to main.
- origin/feat/s1-input-hardening: zod validation, rate limits (6000/min global, 300/min per stream), stream id rule [A-Za-z0-9][A-Za-z0-9._-]* ≤128 per segment.
- origin/feat/sec28-publisher-auth: per-stream publish key = HMAC-SHA256(PUBLISH_KEY_SECRET, streamId).hex.slice(0,32); verified constant-time in packages/stream-uploader/src/utils/publishKey.ts; enforced in src/engines/srs.ts:217-232 and src/engines/ome.ts:452-467; StreamClaimant.isAuthenticated for takeover; deploy/scripts/publish-key.sh prints URLs; PUBLISH_KEY_SECRET only to uploader container; empty = feature off.
- origin/feat/e2e-publish-key: SEC-28 merged + SEC-29 (key checked on stop/unpublish path); derivation moved to packages/shared/src/publishKey.ts (subpath export).
- origin/feat/multi-feed-abr-on-swarm: ABR ladder; no publish-key code.

## Ingest
Engines: srs (SRT+RTMP) | ome (SRT only). Ports base table deploy/scripts/_lib.sh:73-81: API_PORT 10000, SRS_SRT_PORT 10001, SRS_RTMP_PORT 10002, SRS_HTTP_PORT 10003 (+slot*10). OME_SRT_PORT 10081 default.
Secrets: SRT_PASSPHRASE is ONE server-level value in srs.conf srt_server{} (engines/srs/srs.conf.template:11-19; empty → unencrypted). Cannot be per-stream. OME has no passphrase. SRS_WEBHOOK_TOKEN (branches) service-to-service. OME_ADMISSION_SECRET HMAC. PUBLISH_KEY_SECRET (branches) → per-stream key.
STREAM_KEY (.env) = Ethereum private key signing all feeds — NOT an OBS credential; don't reuse the name.
Stream id = `${app}/${stream}` (buildStreamId); app 'audio' → audio else video (resolveMediaType). No registry; any name accepted.
URLs today (main): SRT `srt://HOST:SRS_SRT_PORT?streamid=#!::r=<app>/<stream>,m=publish` (+ OBS Passphrase field = SRT_PASSPHRASE); RTMP server `rtmp://HOST:SRS_RTMP_PORT/<app>` stream key `<stream>`; OME `srt://HOST:OME_SRT_PORT?streamid=srt://HOST:OME_SRT_PORT/<app>/<stream>`.
With publish key (branches): RTMP `rtmp://HOST:PORT/<app>/<stream>?key=<32hex>`; SRT `srt://HOST:PORT?streamid=#!::r=<app>/<stream>?key=<key>,m=publish`; OME `srt://HOST:PORT?streamid=srt%3A%2F%2FHOST%2F<app>%2F<stream>%3Fkey%3D<key>` (percent-encoding load-bearing).

## Feed publishing (single rendition)
Both feeds signed by STREAM_KEY (one owner):
- Catalog feed: Topic.fromString(STREAM_LIST_TOPIC default "swarm-stream"); payload JSON ARRAY of entries, rewritten whole; src/libs/StreamCatalog.ts: makeFeedWriter(topic, signer).uploadPayload(stamp, JSON.stringify(state), {index: nextIndex, deferred:true}); read-modify-write via makeFeedReader.downloadPayload({index}), dedupe by (owner, topic); index recovered on boot (404 never used, 503 empty); @sec28 CatalogIndexStore persists last index to STATE_DIR/catalog/feed-index.json (two writers at one index fork the feed!).
- Per-stream manifest feed: Topic.fromString(streamRawTopic = crypto.randomUUID()), payload = HLS playlist text, one index per update; segments via bee.uploadData(stamp, data, {redundancyLevel:1}) refs into playlist (bare ref or MANIFEST_ACCESS_URL/ref). Live window 10; VOD adds ENDLIST.
Entry (StreamEntry, StreamCatalog.ts:10-19; @abr adds group, renditions[]): { title, owner, topic, state:'live'|'vod', mediatype:'video'|'audio', timestamp, index?, duration? }. title auto = DD/MM/YYYY. NO description/thumbnail/tags/scheduled anywhere. 'live' on first manifest publish; 'vod' on stop with index+duration.
ABR (@abr): one media-playlist feed per rung (random uuid topic), one master feed per ladder (topic = group uuid) written by coordinator (lowest rung) bee: MasterFeedWriter; master playlist has #EXT-X-STREAM-INF + `swarm://<owner>/<topic>` URIs; BEE_PUBLISHERS "rung@url<batchid>", one node+batch per rung; coordinator carries catalog + master feed.
Viewer needs owner + topic only. Client: GET bee/feeds/<VITE_APP_OWNER>/<Topic(VITE_APP_RAW_TOPIC)> (build-time), manifest GET bee/feeds/<owner>/<hexTopic> then Swarm-Feed-Index header; updates GET bee/soc/<owner>/<keccak256(topic||index)>; segments bee/bytes/<ref>. Catalog polled every 5s. No aggregator/GSOC in this stack.

## Control surface (packages/stream-uploader/src/api/routes/stream.ts)
POST /stream/start {streamId, mediatype} (main: no auth; @sec28 bearer API_AUTH_TOKEN, 409 if held) | POST /stream/segment raw + x-stream-id/x-segment-index/x-duration | POST /stream/stop {streamId} (@sec28 202 + statusUrl) | GET /stream/status?streamId (@sec28) | GET /health.
Engine webhooks: POST /engines/srs/streams (on_publish→startStream, on_unpublish→stopStream), POST /engines/srs/hls (on_hls segment); POST /engines/ome/admission.
End-to-end today: nothing pre-creates a stream. OBS pushes → SRS on_publish → StreamOrchestrator.startStream → StreamUploader with FRESH RANDOM UUID topic → segments → first manifest write → notifyStart appends catalog entry (title=date) → on_unpublish → VOD.
No API/CLI creates a stream record or issues a credential from outside (only operator-run publish-key.sh @sec28).

## Minimal change paths
- Zero-change: admin backend derives the same HMAC key with the master secret (packages/shared/src/publishKey.ts @e2e-publish-key) and renders URLs. No revocation.
- Revocation/expiry: inject a PublishKeyVerifier at hasValidPublishKey's two call sites (srs.ts:217, ome.ts:452) → call admin API GET /streams/{id}/publish-key/verify (cached, fail-closed) or verify signed token. New env only for uploader container.
- Metadata: seam StreamUploader.notifyStart() (:238-246 @sec28); (a) POST /stream/start accepts title/description and engine path looks up draft by streamId at on_publish (same lookup as verifier) or (b) admin writes own metadata feed.
- Publishing a draft to the catalog: (i) new uploader endpoint handing entry to StreamCatalog (safe) vs (ii) admin writes catalog feed with same key/topic → forks the uploader's cached index. If admin writes a feed, it must be its own feed (own key or exclusive writer).

## msrs-uploader (old system)
A loopback HTTP server behind an admin token. intake/<name>/metadata.json {title, description, tags} → transcode writes full record {owner, topic uuid, title, description, tags, state:'vod', mediaType, thumbnail:'', createdAt, updatedAt, index:1, isExternal:true, duration}; uploader uploads segments, manifest as single feed update at index 1 signed by STREAM_OWNER_KEY, announces the stream to an aggregator through an encrypted GSOC token. Aggregator owns list feed (STREAM_STATE_OWNER/'swarm-stream'), caps 10 entries (isExternal exempt). War stories: GSOC uploaded by the subscribing node never reaches subscribers → use gateway /write pool; gsocSubscribe had no onclose; list >4096 bytes needed bee-js 13.
