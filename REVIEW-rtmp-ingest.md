# Review: `feat/rtmp-ingest`, the two halves together

Reviewed on 2026-10-03. Read only. No code was changed.

| Priority | Count |
| -------- | ----- |
| P1       | 2     |
| P2       | 3     |
| P3       | 4     |

P1 and P2 in one line each:

- **P1-1.** The manager opens RTMP on every SRS stage whatever stack it runs, and every stack that can run today lets anyone play any live broadcast over that port with no key.
- **P1-2.** With RTMP open, an SRT passphrase no longer stops a stranger from publishing or taking a broadcast over, and the shared warning tells broadcasters the opposite.
- **P2-1.** The manager's RTMP reading needs a `vhost=` suffix on an SRS log line that the stack never asks the fork image to print.
- **P2-2.** The manager accepts any text for `RTMP_TAKEOVER`, and the stack's SRS refuses to start on anything but `on` or `off`.
- **P2-3.** The manager and root docs say opening the firewall is all RTMP takes, and none names the stack version and image a stage needs first.

## Decided after the review

Decided on 2026-10-03, after reading P1-1 and P1-2:

- **RTMP is off by default, and SRT is the ingest broadcasters use.** The manager's firewall keeps every RTMP port closed, stage records say `rtmpPublic: false`, and neither console offers RTMP. This closes P1-1 and P1-2 for every stage.
- **"Off" means closed to the outside, not switched off inside SRS.** SRS keeps its RTMP listener, because the ABR ladder republishes every rung to it over loopback. The stack's RTMP work stays: the health check, the takeover and loopback-only play.
- **Before RTMP is ever opened on a stage,** that stage must run a stack whose SRS allows play from loopback only, on an image that accepts the stack's config. A per-stage way to open RTMP is left for later.
- **The shared RTMP warning is corrected anyway,** so it says what the stack does on any stage where RTMP is open.
- **This reverses the roadmap entry "RTMP at the same level as SRT".** The roadmap is updated with the new decision. Its owner should confirm it.

## What was reviewed, and how

- Branch `feat/rtmp-ingest` at `415a73a88b53b12f8b8241cb5c78ff085b4ba5a7`, 37 commits on `main` at `9da045354`, as the brief names them. The diff is `git diff 9da045354 415a73a8`.
- The remote branch has moved since the brief was written. It now ends at `440efb80` ("Copy publish URL adds the RTMP server and stream key where RTMP is open"), one commit on top of the reviewed head. The brief names `415a73a8`, so that commit is left out of this review.
- The clone's own `main` is an older branch point and not `9da045354`. The review uses `9da045354` as its base, as the brief says.
- Unit suites were run on Node 24.21.0 and pnpm 12.4.1. The Corepack that ships with Node could not start pnpm 12, so pnpm 12.4.1 was run through its own entry point instead. `pnpm install --frozen-lockfile` passed. The results are under "Unit suites" at the end.
- No SRS image `6.0-r2-swarm.3` exists, so nothing here was run against a live SRS.

## Findings

### P1-1. RTMP is opened to the internet on stages whose SRS lets anyone play

**Where.** `apps/infra-manager/common/src/portPolicy.js:59` adds the `rtmp_ingest` band, TCP `10002 + 10 × slot` for slots 1 to 100. `apps/infra-manager/manager/src/domain/stages/StageRecordBuilder.ts:110` sets `rtmpPublic` from the engine alone, so every SRS stage says `true` on its next push, and the admin then offers RTMP for it (`apps/web2-admin/backend/README.md:897` says so). The stack's protection is new on this branch: `apps/hls-stream/engines/srs/srs.conf.template:49` and the ABR vhost in `entrypoint.sh` allow play from loopback only. On `main` the template has no `security` section at all.

**What breaks.** Neither the band nor `rtmpPublic` looks at the stack version a stage runs. `apps/hls-stream/engines/README.md:267` ("Play is loopback only") says what an open RTMP port means without the rule: anyone who reaches it can play any broadcaster's source, any SRT broadcast through SRS's bridge, and every rung with `?vhost=abr`, all with no key. Today every SRS stage runs a stack without the rule, for two reasons:

1. Every stack version before this branch lacks it.
2. This branch's stack cannot start on the pinned image `6.0-r2-swarm.2`, because its template carries the RTMP `takeover` line only `6.0-r2-swarm.3` accepts. That pin is known and not a finding here. But it means the play rule cannot run anywhere until that image exists.

A stage that runs its own SRS config file, which the manager offers through `engineConfig`, loses the rule the same way. The stack says so in its own README, and the manager does not check for it.

**Damage path.** The manager upgrades. The operator follows `apps/infra-manager/deploy/README.md:535` ("Upgrading to RTMP ingest"), which asks only for a new inventory export and firewall draft. Once the draft is applied, every live broadcast on every SRS stage of that host can be played by anyone over the internet who knows its stream id. Stream ids are `<media type>/<topic>`, and a published stream's topic is in the public catalog feed.

**Cost of fixing.** Small to moderate.

- The play rule needs only stock SRS (`srs_app_security.cpp`). It can ship in its own stack change that also runs on `6.0-r2-swarm.2`, ahead of the takeover line.
- The manager already reads facts out of a version's checkout (`StackContractFeatures` in `apps/infra-manager/common/src/stackVersions.ts:83`), and the stage record already names the version (`StageRecordBuilder.ts:220`). A feature such as "SRS allows play from loopback only" can gate `rtmpPublic`.
- The band is host-wide, so the firewall cannot follow one stage. The upgrade guide has to make redeploying every SRS stage onto a version with the rule a step that comes before applying the draft.

**Recommendation.** Do not ship the manager's band or the `rtmpPublic` change until the play rule runs on stages. Land the play rule first, gate `rtmpPublic` on the version feature, and put "redeploy SRS stages first" into the upgrade steps. This was decided without asking, because the brief's own P1 rule covers it: a port open that should be closed.

### P1-2. Opening RTMP turns the SRT passphrase off as a publish gate, and the shared warning says the opposite

**Where.** `packages/contracts/src/ingest.ts:74` (`rtmpUnencryptedWarning`), shown by the admin's OBS panel and the manager's Publish card, ends: "On a network you do not trust, broadcast over SRT with a passphrase instead." The manager docs, `docs/ROADMAP.md:393`, `docs/architecture/overview.md` and `docs/self-hosting.md` all say the same thing. The stack says otherwise in three places:

- `apps/hls-stream/engines/srs/.env.sample:104`
- `apps/hls-stream/engines/README.md:129`
- `apps/hls-stream/deploy/README.md:219`

All three say that SRT sends its stream id, key included, before encryption starts, "so while the RTMP port is open a key read off an SRT connection works on it too".

**What breaks.** Before this branch, someone who read a key off an SRT connection still needed the passphrase to publish, because the firewall kept RTMP closed. With RTMP open on every SRS stage, the passphrase stops nobody. That stranger can publish over RTMP with the key alone. The stack also turns `RTMP_TAKEOVER` on wherever keys are checked (`entrypoint.sh`, the `rtmp takeover` block), which is every stage linked to the admin. So they can replace a live SRT broadcast while it is on air, because the setting that applies is the new publisher's protocol (`engines/README.md`, the takeover table).

A broadcaster who follows the warning, on exactly the network it warns about, is the one exposed. The stack's own uploader README (`apps/hls-stream/packages/stream-uploader/README.md:881`) states both claims in one sentence: "the passphrase is what protects that form", then that a key read off either protocol works over RTMP.

**Damage path.** Someone passively watching a broadcaster's network takes the broadcast over and shows their own picture under the stage's feed.

**Cost of fixing.**

- Correcting the shared text is one function in `packages/contracts`, plus the six doc paragraphs that copy it. That part is small.
- Giving an operator a way to keep RTMP closed on a stage that relies on its SRT passphrase is moderate. One way is a stack setting that binds SRS's public RTMP listener to loopback, which keeps the ladder's loopback republish working. The manager would then set `rtmpPublic` from that setting.
- A smaller stopgap is to leave `RTMP_TAKEOVER` off by default where `SRT_PASSPHRASE` is set. That stops the takeover of a live broadcast, but not a publish while the broadcaster is away.

**Recommendation.** Before shipping, fix the text so it says what the stack does: while RTMP is open on a stage, the passphrase keeps the picture private but does not keep the key private, and a key read off either protocol publishes over RTMP. Put the per-stage way to keep RTMP closed to the owner as a decision, because the roadmap records that the owner chose RTMP at the same level as SRT.

### P2-1. The manager's RTMP reading depends on a log change the stack never asks for

**Where.** The manager's parser and docs are `apps/infra-manager/manager/src/domain/ingestHealth/rtmpPublishReport.ts`, `rtmpIngestReading.ts:16`, `apps/infra-manager/docs/features/srt-ingest-health.md` ("The RTMP part") and `apps/infra-manager/manager/README.md`. All of them rely on the fork's `6.0-r2-swarm.3` ending the `<- CPB` line with `, vhost=<the configured vhost>`, and on that vhost being `__defaultVhost__` for a broadcaster whatever host they dialled.

The stack is the half that pins and documents the fork image. Its table of what each image brings (`apps/hls-stream/engines/README.md:100`) lists only the RTMP `takeover` for `6.0-r2-swarm.3`. Nothing in `apps/hls-stream` mentions the `vhost=` suffix, and nothing on the stack side reads the `CPB` line.

**What breaks.** Each half is consistent alone. Together, it depends on how the image is built:

- If the image is built from the stack's list, it prints no suffix. The manager then shows "RTMP not measured on this engine version" for every RTMP broadcast, forever.
- If the suffix prints the vhost the broadcaster dialled rather than the one SRS resolved, the test fixture shows how that line could read: `client identified ... vhost=ingest.example.org`. The manager then sees reports that name a vhost but never `__defaultVhost__`, and answers `no_reports`. The card says "No publisher" while an RTMP broadcast is live.

**Cost of fixing.** Small. Add the suffix, with its exact value, to the stack's image table and to whatever the fork's build follows. Add one stack-side check that the line has that shape once the image exists, for example in the e2e `rtmp-publish` suite.

**Recommendation.** Do it in the same change that moves the pin to `6.0-r2-swarm.3`.

### P2-2. Any text the manager saves as `RTMP_TAKEOVER` other than `on` or `off` stops SRS from starting

**Where.** `apps/hls-stream/engines/srs/.env.sample:106` declares `# RTMP_TAKEOVER=`, so the manager's settings list offers it, under that exact name, as a deployment setting read from the version's sample. `apps/infra-manager/common/src/stackSettingFields.ts` gives it no shape, so the manager takes any text. The entrypoint runs `require_on_off RTMP_TAKEOVER` (`entrypoint.sh:253`), which exits 1 on anything but `on` or `off`.

**What breaks.** An operator types `true`, the form every boolean setting in the manager takes. The save passes, the deploy recreates SRS, and SRS exits at start and restarts in a loop. Nobody can broadcast until the operator finds the line in the container log. `SRT_TAKEOVER` has the same gap and was already there before this branch. This branch adds a second key that can fall into it.

**Cost of fixing.** A few lines: add `RTMP_TAKEOVER` and `SRT_TAKEOVER` to `STACK_SETTING_FIELDS` as choices of empty, `on` and `off`, and add a test.

**Recommendation.** Fix both keys together, before the first manager release that lists `RTMP_TAKEOVER`.

### P2-3. The docs outside the stack describe RTMP as a firewall change alone

**Where.**

- `docs/ROADMAP.md:393` ("RTMP ingest beside SRT") lists only the manager half: the band, the policy version and `rtmpPublic`. It records none of the stack's decisions:
  - the RTMP takeover and its default
  - loopback-only play
  - the health check covering RTMP
  - the dependency on `6.0-r2-swarm.3`
- `apps/infra-manager/deploy/README.md:535`, `apps/infra-manager/docs/features/auth-and-public-access.md` and `docs/self-hosting.md` step 7 say that a new firewall draft is all RTMP needs.
- `AGENTS.md` asks for the roadmap to be updated when a decision lands.

**What breaks.** An operator following the root and manager docs does things in the order that opens P1-1. Nothing outside `apps/hls-stream` says which stack version and image a stage needs first.

**Cost of fixing.** Small: a few paragraphs.

**Recommendation.** Make it part of the P1-1 fix. Add the stack's decisions and the order of the upgrade to the roadmap entry and to the three upgrade texts.

### P3-1. The warning hedges the takeover where the stack makes it certain

`rtmpUnencryptedWarning('stage')` says "On a stage that lets a reconnecting encoder replace one whose connection dropped". Every stage the admin shows checks keys, though, so on `6.0-r2-swarm.3` the stack turns the RTMP takeover on for all of them unless `RTMP_TAKEOVER=off`. Reproduction: push a stage from a deployment linked to the admin with `RTMP_TAKEOVER` unset, and `takeover on` is in its rendered SRS config while the panel says "on a stage that lets".

### P3-2. The warning recommends a passphrase on a stage that has none

The admin's OBS panel can show "No SRT passphrase is configured on this stage." above the RTMP warning, which tells the broadcaster to use "SRT with a passphrase instead". Reproduction: open the OBS panel of a stream on an SRS stage whose record has `srtPassphrase: null`.

### P3-3. The RTMP band's slot 100 lands on a port the stack gives to slot 0's 480p rung node

The policy opens slots 1 to 100, and the stack refuses slot 100 and uses `11002` as slot 0's `BEE_RUNG_480P_P2P_PORT` (`apps/hls-stream/deploy/scripts/_lib.sh`). So the firewall generator now refuses an inventory that holds such a node, as "11002 is a public rtmp_ingest port". Reproduction: run `firewall-rules.sh` on an inventory with a slot 0 ABR stack running its rung Bee nodes. The viewer band already does the same at `11004`. Found by reading only.

### P3-4. The stack's RTMP health verdict never reaches the manager

The SRS health check now fails when the RTMP listener is gone or held by another container. But the manager reads no container health status for SRS, and no manager deploy runs `wait-for-ingest.sh`. The only caller of that script is `deploy/scripts/bench-profiles.sh`. So on a manager deployment the new check is visible only in `docker ps` on the host. The SRT check has had the same gap since before this branch. Reproduction: deploy an SRS stage from the manager with a config file of the operator's own whose RTMP `listen` is not `SRS_RTMP_PORT`. `docker ps` shows `srs` as unhealthy, and the manager's Ingest card says "No publisher".

## Answers to the six questions

### 1. Ports

Yes, the port is the same everywhere, by reading.

- The stack's slot arithmetic is `SRS_RTMP_PORT:1935:10002` in `deploy/scripts/_lib.sh`: `10002 + 10 × slot`, or 1935 at slot 0. Both compose files publish `${SRS_RTMP_PORT:-1935}` on the same number on both sides and put `SRS_RTMP_PORT` into the container. The entrypoint writes SRS's `listen` from it. `healthcheck.sh` and `wait-for-ingest.sh` read the same variable after `apply_port_slot`. The e2e harness resolves it with `{ stock: 1935, base: 10002 }`. `publish-key.sh` prints it after `apply_port_slot`.
- The manager's `rtmp_ingest` role has `base: 10002` and the same stride of 10. The manager's own port table is read from the version's `PORT_VARS`, so the stage record's `rtmpPort` is the same number. The Containers card now records `SRS_RTMP_PORT`. The Publish card's fallback (`urls.ts`, `SRS_RTMP_BASE_PORT = 10002`) and the offline mock (`PORT_BASES`) agree, and the mock's old `10002`/`10003` for SRT and RTMP is fixed.
- Two edges. The manager never uses slot 0, while the stack's docs give 1935 there, which is consistent because the manager's slots run from 1. The manager's band goes to slot 100 while the stack stops at 99 (P3-3).
- One more port the manager does not show: with the ladder on and a slot, the entrypoint also listens on loopback 1935 for the ladder's input. That listener is not public and needs no rule.

### 2. Settings

- **Ports.** The manager passes the slot, and the stack derives `SRS_RTMP_PORT` from it, with the same names on both sides.
- **Takeover.** The manager writes no takeover setting of its own. It offers `RTMP_TAKEOVER` as a plain deployment setting under the stack's exact name, read from the version's `.env.sample`, so name and default agree: unset means on wherever keys are checked. The value shape does not agree (P2-2).
- **Keys.** The admin builds the RTMP Server as `rtmp://<host>:<rtmpPort>/<app>` and the Stream Key as `<topic>?key=<publishKey>` (`packages/contracts`). That is the shape the stack's docs, `publish-key.sh` and the uploader's RTMP hook test use. The manager's Publish card offers `live` and `stream` with no key, the same as its SRT line.
- **Warnings.** The manager sets `rtmpPublic` without reading any stack setting, and the admin reads only that flag. No setting of the stack's, such as a takeover turned off or a stage that keeps RTMP closed, reaches the warning or the offer (P1-2, P3-1).

### 3. Health

They measure different things, they do not contradict each other, and neither claims the other's answer.

- The stack's health check calls RTMP healthy when a TCP socket in `LISTEN` on `SRS_RTMP_PORT` is held by a process in the SRS container, beside the SRT check. The deploy wait checks the same listener from the host.
- The manager's Ingest card does not judge the listener at all. It reports how many RTMP publishers on `__defaultVhost__` SRS reported in the last minute and their 30-second bitrate, and leaves out the ladder's rungs.
- The stack's verdict does not reach the manager. The manager does not read the SRS container's health status, and neither the manager's deploy nor the stack's `deploy.sh` runs `wait-for-ingest.sh`, which only the bench calls. So a dead RTMP listener on a manager deployment shows on the Ingest card as "No publisher" (P3-4).

On the log line, they do not agree, because the stack has no position at all. Only the manager states the `vhost=` format, and the stack's description of `6.0-r2-swarm.3` does not include it (P2-1). Both halves agree that the ingest vhost is `__defaultVhost__` and the ladder's is `ABR_VHOST`, default `abr`.

### 4. Text

- **The warning.** Yes. The admin's OBS panel (`IngestPanel.tsx`) and the manager's Publish card (`publishText.ts`) both call `rtmpUnencryptedWarning` from `packages/contracts`, each through its app's common package, with the owner word `stage` or `deployment`.
- **The help texts.** These are not shared, and each app writes its own:
  - the admin's "Paste into the Server box." and "Paste into the Stream Key box."
  - the manager's `RTMP_BOXES_NOTE`
  - the "unencrypted" label in both Stages pages

  They say the same thing, so this is not a finding.

- **Whether they say what the stack does.** Not fully. The shared warning recommends SRT with a passphrase without saying that open RTMP takes the protection of the key away from it (P1-2). It hedges a takeover the stack turns on for every admin stage (P3-1). And it gives that advice on stages with no passphrase (P3-2).

### 5. Docs

The three apps agree on the facts each half owns:

- the port and its arithmetic
- that OvenMediaEngine takes SRT alone
- that RTMP is plain and unencrypted
- that `rtmpPublic` is set on every SRS stage

They disagree in two places:

- The stack's docs say a key read off SRT works over open RTMP. The manager's, the admin's and the root docs do not, and recommend SRT with a passphrase without that qualification (P1-2).
- The manager's and the root docs describe the upgrade as a firewall change and leave out the stack version and image it needs (P2-3).

The admin's docs (`backend/README.md`, `frontend/README.md`, `docs/architecture/web2-admin-checkpoint-2.md`) match the code: the retired `INGEST_RTMP_*` keys, `rtmpPublic` from the stage record, and the warning beside RTMP.

### 6. What works in each half alone and breaks together

- **P1-1.** The manager half opens RTMP on stages whose stack half cannot yet protect play.
- **P1-2.** The stack half says an open RTMP port lets an SRT key publish without the passphrase. The manager half opens the port, and the shared text recommends SRT with a passphrase as safe.
- **P2-1.** The manager half reads a log suffix the stack half does not ask its image for.
- **P2-2.** The manager half saves a takeover value the stack half refuses to start on.

## Unit suites

Run at `415a73a8` with `pnpm --filter <package> test`, on Node 24.21.0 and pnpm 12.4.1. Every suite passes.

| Package                                       | Result                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `@streaming-monorepo/contracts`               | 117 of 117 pass                                              |
| `@swarm-hls-stream/deploy`                    | 1,015 tests: 1,008 pass, and the 6 that failed pass on rerun |
| `@swarm-hls-stream/e2e` (unit tests only)     | 2,224 of 2,224 pass                                          |
| `@swarm-hls-stream/stream-uploader`           | 2,000 pass, exit 0                                           |
| `@streaming-infra-manager/common`             | 684 of 684 pass                                              |
| `@streaming-infra-manager/api` (the manager)  | 3,528 of 3,528 pass on rerun                                 |
| `@streaming-infra-manager/frontend-prototype` | 633 of 633 pass                                              |
| `@streaming-monorepo/web2-admin-common`       | 10 of 10 pass                                                |
| `@streaming-monorepo/web2-admin-frontend`     | 220 of 220 pass                                              |
| `@streaming-monorepo/web2-admin-backend`      | 535 of 535 pass                                              |

The first runs failed in this environment, not in the code:

- The container had no `rsync`. One manager test and one deploy test need it. Both passed once it was installed.
- Six deploy tests in `test/uploaderImage.test.js` read the uploader's build output, and the uploader had not been built yet. That file passed 18 of 18 after `pnpm --filter @swarm-hls-stream/stream-uploader... build`.

No e2e suite under `suites/` was run, because they need a live stage. The RTMP suites need image `6.0-r2-swarm.3`, which does not exist yet.
