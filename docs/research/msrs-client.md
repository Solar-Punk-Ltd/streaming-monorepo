# msrs-client research (agent report, 2026-09-11). Repo: scratchpad/repos/msrs-client (== /Users/nandorkomlodi/Work/git/solarpunk/msrs-client, origin/master). README says "MSRS Client - deprecated".

## Stack
Vite 5 + React 18 + react-router-dom 7 HashRouter; @tanstack/react-query v5; plain React Context (Theme→QueryClient→Wagmi→HashRouter→Wallet→User→Waku→App); NO UI kit (hand-rolled components); SCSS with 4 themes via data-theme; wagmi 3 + viem 2 (Gnosis only); @ethersphere/bee-js ^9; @solarpunkltd/swarm-chat-js + waku-sdk; hls.js 1.6 with custom playlist loader; vitest; Docker→nginx, runtime config via /config.js → window.__CONFIG__.

## Routes (src/routes.tsx)
/ StreamBrowser | /watch/:mediatype/:owner/:topic StreamWatcher | /create + /edit/:owner/:topic StreamForm (two-stage: edit → preview → confirm) | /manage StreamManager (Show token / Pin / Unpin / Edit / Delete, Create New Stream) | /stamps StampDashboard | /uploader StreamUploader (archive/restore). Admin routes wrapped in AdminGuard (isAdmin = !!session.instanceId; isSolarpunkAdmin = instanceId==='solarpunk').

## Auth (all client-side, no login endpoint)
- Viewer nickname login: random UUID → keccak256 → throwaway PrivateKey; instanceId '' → not admin.
- Admin login (src/utils/auth/login.ts:259-303): find AdminConfig{instanceId,swarmRef,createdAt} in localStorage['admin_configs'] (seeded from Swarm feed owner=VITE_STREAM_STATE_OWNER topic=Topic.fromString(VITE_REGISTER_TOPIC='SWARM_REGISTER')); GET {READER_BEE}/bytes/{swarmRef} → CredentialBundle{instanceId, checksum=sha256(password+'check').slice(0,8), encrypted{encrypted,salt,iv,authTag b64}, createdAt}; PBKDF2-SHA256 100k iters + AES-256-GCM → UserCredentials = Session{instanceId, userId(eth addr no 0x), userSecret(priv key no 0x), serverKeys{nginx,msrsIngestion,streamAggregator}, username 'admin@<instanceId>', createdAt}.
- Bundles created by msrs-utils/auth-manager/accountGen.js (Wallet.createRandom; serverKeys from env NGINX_ADMIN_SECRET, MSRS_INGESTION_API_KEY, STREAM_AGGREGATOR_API_KEY → shared server secrets handed to the browser).
- Session persisted in localStorage['msrs_session']; no expiry/refresh.
- Admin HTTP APIs: header 'X-MSRS-Admin-Token': serverKeys.nginx, base = origin(READER_BEE_URL): GET /admin/node/status, GET/POST /admin/uploader/{streams,batch,jobs}.
- Token format (TokenGenerator.generateServerToken, mirrored in msrs-uploader/src/aggregator.js:24-69):
  payload={u:userId,s:userSecret,message}; msgpack → pako.deflate → AES-256-GCM(key=SHA256(serverKeys[type]), iv 16B) → {encrypted,iv,authTag b64};
  dataToSign={i:instanceId,p:encrypted,c:createdAt,e:expiresAt}; signature=HMAC-SHA256(msgpack(dataToSign), key=userSecret).hex; token=bs58(msgpack({s:signature,...dataToSign})).
  streamAggregator tokens expire 24h; msrsIngestion tokens (= the OBS stream key) expire 672h (28 days); ingestion checks expiry only at connect.

## Stream model (src/types/stream.ts)
MediaType video|audio; StateType live|vod|scheduled; ActionType create|update|delete.
StateEntry{title, state, owner(hex addr), topic(uuid v4 = stream id), mediaType, createdAt(ms, set by aggregator), updatedAt(ms), index?(feed index of final manifest), duration?(s), thumbnail?(bzz ref hex), description?, scheduledStartTime?(ISO), isExternal?, tags?, pinned?}. StateArrayWithTimestamp{entries, lastModified}.
Messages: {action:'create', data:StateEntry} | update Partial | delete Partial. Ingestion message MsrsIngMessage{t:streamStateTopic, o:streamStateOwner, si:`${owner}/${topic}`, m:mediaType}.
Protobuf mirror for Waku: owner1 topic2 title3 state4 mediaType5 createdAt6 updatedAt7 index8 duration9 thumbnail10 description11 scheduledStartTime12 pinned13 tags14(rep) isExternal15; StreamList{entries=1, lastModified=2}.

## Form (StreamForm.tsx / useStreamForm.ts / StreamFormFields)
title ≤100 required; description ≤500 required; tags ≤10, ≤20 chars each, dedup; mediaType radio Video Stream|Audio Only (hidden when editing live/vod); thumbnail image/* ≤5MB (not required); scheduledStartTime datetime-local min=now, required on create, hidden on live/vod edit. Preview → Create Stream/Update Stream. Errors: 'Failed to create stream'. After submit: refreshStreamList() then navigate('/manage').

## What create writes to Swarm (src/utils/stream/stream.ts, 126 lines)
bee=new Bee(VITE_WRITER_BEE_URL); stamp=VITE_STAMP; gsoc signer=new PrivateKey(VITE_STREAMER_GSOC_RESOURCE_ID) (private key in browser!); identifier=Identifier.fromString(VITE_STREAMER_GSOC_TOPIC).
1. if thumbnail: bee.uploadFile(stamp, file) → ref hex.
2. message={action:'create',data:{owner:session.userId, topic:crypto.randomUUID(), title, description, state:'scheduled', mediaType, thumbnail:ref, scheduledStartTime??null, tags}}; token=createStreamAggregatorToken(session,message); bee.makeSOCWriter(signer).upload(stamp, identifier, utf8(token)).
Client never writes the stream-list feed; the off-client stream-aggregator consumes the GSOC chunk, verifies token, republishes whole list to feed (owner=VITE_STREAM_STATE_OWNER, topic=Topic.fromString(VITE_STREAM_STATE_TOPIC e.g. 'swarm-stream')) as JSON StateArrayWithTimestamp, and over Waku (protobuf). update/delete/pin use same GSOC pattern with partial data.

## Caveats (why a DB draft helps)
1 no draft; failure loses stream; 2 orphan thumbnail; 3 fire-and-forget, success inferred by polling list (3.5s Waku race / 3×4s feed retries), navigate('/manage') unconditional; 4 all admins write the same SOC address → clobbering; 5 GSOC private key + server API keys in browser localStorage; 6 topic minted client-side, no ownership validation; 7 single static stamp, no TTL/utilisation check; 8 timestamps assigned by aggregator; 9 editing can clear thumbnail (null→''); 10 edit deep-link needs list loaded; 11 feed index bookkeeping fragile.

## Discovery / playback
One global feed index. readerBee.makeFeedReader(Topic.fromString(streamStateTopic), streamStateOwner). Poll next index (404 = not yet). Waku channel 'solarpunk-msrs-stream-channel', content topic /solarpunk-msrs/1/${owner}-${topic}/proto. Accept only if lastModified newer.
Player: hls.loadSource(`${owner}/${topic}`) with custom loader: hexTopic=Topic.fromString(topic); live → GET {READER}/feeds/{owner}/{hexTopic} (index from Swarm-Feed-Index header); VOD/external → GET /soc/{owner}/{makeFeedIdentifier(topic, FeedIndex(index??1))}; feed identifier = keccak256(topic.bytes||feedIndex.bytes). Thumbnail fallback captures a frame from the index-1 manifest.

## Stream key UI (StreamManager.tsx:87-116)
Only for state==='scheduled': tokenMsg={t:streamStateTopic,o:streamStateOwner,si:`${owner}/${topic}`,m:mediaType}; token=createMsrsIngestionToken(session,tokenMsg); modal "Your stream key" / "Your stream key has been copied to your clipboard. Use it to start your broadcast." / raw token / Close. NO RTMP/SRT URL or passphrase anywhere in the client; msrs-utils README lists Ingestion on RTMP 1935 (ghcr.io/solar-punk-ltd/msrs-ingestion). Operator tells streamer the URL by hand.

## Uploader/archive API (src/utils/network/uploaderService.ts) base {origin}/admin/uploader, header X-MSRS-Admin-Token
GET /streams → UploaderStream[]; GET /batch → {archive,chat}; GET /jobs; POST /jobs {type:'restamp',topic} | {type:'restore',topic,external}. GET /admin/node/status → rotating stamp slots locked per stream_id (media|chat), pinned survive rotation.

## Env (src/utils/shared/config.ts; window.__CONFIG__ then import.meta.env; missing throws)
VITE_READER_BEE_URL, VITE_WRITER_BEE_URL, VITE_STAMP, VITE_STREAM_STATE_OWNER, VITE_STREAM_STATE_TOPIC(swarm-stream), VITE_REGISTER_TOPIC(SWARM_REGISTER), VITE_CHAT_GSOC_RESOURCE_ID, VITE_CHAT_GSOC_TOPIC, VITE_STREAMER_GSOC_RESOURCE_ID, VITE_STREAMER_GSOC_TOPIC, VITE_MESSAGE_RECEIVE_MODE(swarm|waku|both, default waku), VITE_WAKU_STATIC_PEER, VITE_THEME(solarpunk|cryptomondays|swarm|ethis).
Gnosis constants: POSTAGE_STAMP_CONTRACT 0x45a1502382541Cd610CC9068e88727426b696293, POSTAGE_BATCHER 0xf9E92Fa33e697Ba3059Bc25ba1448Cd899b16e51, MULTICALL3 0xcA11bde05977b3631167028862bE2a173976CA11.

## Chat
SwarmChat({user:{nickname,privateKey}, infra:{beeUrl:WRITER, gsocResourceId:chatGsoc, gsocTopic, chatAddress:streamStateOwner, chatTopic:`chat-${topic}`, enveloped:false, ...}}); optional Waku transport; TEXT|REACTION|THREAD.

## Minimum surface for web2-admin (agent's recommendation)
1 server-side users/sessions; keep instanceId tenant + solarpunk superadmin; serverKeys stay server-side; backend mints tokens (Node: msgpack-lite, zlib.deflateSync, aes-256-gcm, createHmac sha256, bs58 — as msrs-uploader/src/aggregator.js does).
2 streams table = StateEntry columns + status draft/published, swarm_published_at, idempotency key, thumbnail_ref; keep topic uuid + owner as external identity.
3 publish job: upload thumbnail → build message → mint aggregator token → write GSOC → poll feed for confirmation → record.
4 admin reads from Postgres; viewer still reads the feed; reconcile state/index/duration back into DB.
5 POST /streams/:id/stream-key → 28-day msrsIngestion token + RTMP URL (new).
6 proxy /admin/node/status and /admin/uploader/* through backend.
