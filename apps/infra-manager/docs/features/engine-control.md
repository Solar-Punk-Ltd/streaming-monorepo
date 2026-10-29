# Engine control

Engine control is how you see and steer a deployment's media server from the console: its settings, a restart, its logs and the config it is running. This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys the streaming stack (`apps/hls-stream`) onto hosts.

## What it does

A stream deployment runs a media server, the **engine**, that takes the SRT feed from the broadcaster and cuts it into HLS segments for the uploader. The stack has two engines: SRS, the default, and OvenMediaEngine (OME). Each runs from a stock image with a config template and an entrypoint script from the stack (`engines/srs/srs.conf.template` and `entrypoint.sh`, `engines/ome/Server.xml.template` and `entrypoint.sh`). At container start the entrypoint fills the template from environment variables and refuses to start on a value it cannot place safely.

Those variables reach the container through compose interpolation of three files the deploy script assembles:

- the deployment's `.env.<name>`, which the manager writes from its database on every deploy,
- the engine's own `engines/<engine>/.env.<name>`, created once from the engine's `.env` or its sample, which the manager does not touch,
- a per deploy override file with the resolved ports and host names.

Changing an engine setting therefore means storing it in the database, writing it into `.env.<name>`, and recreating the containers that read it. A deployment can also run its own engine config file instead of the version's template, see [engine-config.md](engine-config.md).

The SRS web console is not served on any deployment, because the stack mounts the media volume over its directory.

## The Engine card

Every stream and ABR uploader deployment page has an **Engine** card, between **Publish** and **Stack settings**.

- The header names the engine, `SRS 6` or `OvenMediaEngine`, with a status pill and four buttons: **Settings**, **Config file**, **Restart** and **Logs**.
- The card lists what the engine runs with and where each value comes from. The sources are **Deployment override**, **Host default**, **Manager default**, **Stack default**, **Set in config file** and **Engine default**. A value the card cannot read reliably is **Unverified** or **Not specified**, with a reason.
- A live status block says why it cannot show what is publishing right now. On a version that does not publish the SRS API port it says `Live status needs the SRS API port, which this stack version does not publish.` On a version that does, it says `This stack version publishes the SRS API port. Reading live status from it is not built into the manager yet.` On OvenMediaEngine it says `Live status needs the OvenMediaEngine API, which this stack version does not enable.`
- **Settings** brings the deployment's **Stack settings** card into view with its **Engine settings** section open and the first setting focused. Engine settings are edited there, see [The settings](#the-settings).
- **Config file** opens the engine config editor, see [engine-config.md](engine-config.md).
- **Restart** asks first, for example `Restart SRS 6 for stream1?`, and says what a restart costs: for the engine, the publisher is disconnected for a few seconds and reconnects if the broadcaster is set to retry. Settings are not changed. Restart is off while the deployment is stopped or a deploy is running, and the button's tooltip says why.
- **Logs** opens a dialog with the last 200 lines of a container, a **Refresh** button and a switch between the deployment's containers. Its second tab, **Effective config**, shows the generated `srs.conf` or `Server.xml` as the running container has it, read only, with a copy button. It is the fastest way to see which values actually applied.

The SRS API, once a version publishes its port, has no authentication enabled. The firewall rules in [auth-and-public-access.md](auth-and-public-access.md) cover that port. OvenMediaEngine's API is off in the stack's template.

The **At a glance** card shows the engine in one line, such as `SRS · segment 2 s · window 15 s`, from the same readings as the Engine card. A value saved but not yet applied is marked `saved, not applied`.

## The settings

The settings are defined once in `common/src/engineSettings.ts` (`SRS_SETTINGS`, `OME_SETTINGS`), which the manager, the console and the offline mock all read. Each field has a key, a label, a unit, a kind (`number`, `integer` or `choice`), bounds or choices, help text copied from the stack's samples, and for a field the engine's template carries, the placeholder its value fills. Which keys a version actually reads comes from that version's contract.

| Engine | Key                        | Label                     | Unit              | Bounds or choices         |
| ------ | -------------------------- | ------------------------- | ----------------- | ------------------------- |
| SRS    | `HLS_FRAGMENT`             | Segment length            | seconds           | 0.5 to 30                 |
| SRS    | `HLS_SEGMENT_MAX`          | Force-close a piece after | seconds           | 0.5 to 30                 |
| SRS    | `HLS_WINDOW`               | Playlist window           | seconds           | 1 to 600                  |
| SRS    | `SRT_LATENCY`              | SRT latency               | milliseconds      | whole number, 20 to 10000 |
| SRS    | `ABR_FPS`                  | Frame rate                | frames per second | 1 to 120                  |
| SRS    | `ABR_PRESET`               | Encoder preset            |                   | an x264 preset            |
| SRS    | `ABR_PROFILE`              | H.264 profile             |                   | an H.264 profile          |
| SRS    | `ABR_THREADS`              | Encoder threads           | per rung          | 0 to 64                   |
| SRS    | `ABR_ACODEC`               | Audio codec               |                   | `copy`, `aac`             |
| SRS    | `ABR_AUDIO_BITRATE`        | Audio bitrate             | kbps              | 8 to 512                  |
| SRS    | `ABR_VBV_SECONDS`          | Encoder buffer            | seconds           | 1 to 10                   |
| OME    | `HLS_SEGMENT_DURATION`     | Segment duration          | seconds           | 0.5 to 30                 |
| OME    | `HLS_SEGMENT_COUNT`        | Segment count             | pieces            | 2 to 30                   |
| OME    | `OME_HLS_POLL_INTERVAL_MS` | Poll interval             | milliseconds      | 50 to 10000               |

The `ABR_*` transcoding settings, and each rung's width, height and bitrate (`ABR_RUNG_360P_WIDTH` and the rest), apply only to an ABR uploader. The rung names are fixed, because they are the contract with the node pool. See [Each rung's size and bitrate](abr-ladder.md#each-rungs-size-and-bitrate).

Each field in the console shows its label with its key, its unit, the default an unset value falls back to on this host, and its help. The console checks what the entrypoint checks: positive numbers, whole numbers where required, a force-close ceiling at or above the segment length, and for ABR, frame rate times segment length must be a whole number, because that product is the keyframe interval every rung shares. A pair the engine would refuse is named once above **Save**, which stays off. Every value must also use only letters, digits and `. _ ~ -`, because the entrypoint splices it into the config with `sed`.

A save stores the settings and recreates nothing. **Apply** on the Stack settings card then recreates the containers that read what changed: the engine for an engine setting, the engine and the uploader for the segment length, and the uploader alone for the OvenMediaEngine poll interval. [deployment-settings.md](deployment-settings.md) describes the card.

Creating a group with `POST /groups` takes `engine_settings` and writes them to every member, and a member added later takes what its siblings run.

### Defaults the manager owns

Two settings have a default that belongs to the manager rather than the stack (`managerOwnsDefault` on the field). For every SRS deployment that stores no value, the manager writes it into `.env.<name>` on every deploy:

- **Segment length**, `HLS_FRAGMENT=2`. The stack has no default and refuses to start without one. A version that falls back to a number of its own is given 2 all the same.
- **SRT latency**, `SRT_LATENCY=2000`. Two seconds gives a broadcaster on the open internet time to resend lost packets. The bounds are the manager's: under 20 leaves no time for a resend, and above 10000 overflows SRS's default receive buffer at a typical broadcast bitrate.

A value set in the host's base `.env` wins over these, as it does for every setting, and the card then names the host as the source. The Engine card labels the manager's value **Manager default**.

### How SRT latency is read

SRS applies `latency` to both directions and `recvlatency` after it, and falls back to 120 milliseconds for `recvlatency` when the `srt_server` block leaves it out. So `recvlatency` alone decides how long SRS waits on ingest. The Engine card reads the version's template to tell what the setting will actually do:

- A template that fills both `latency` and `recvlatency` from `SRT_LATENCY` hands SRS the setting. The card shows the stored value, or the default with its source.
- A template that fills only `latency` leaves SRS on its own 120. The card shows 120 as **Engine default**, with the sentence that SRS ignores `latency` for ingest without `recvlatency`. The setting's row in the Stack settings card says a value there has no effect on this version.
- A template that never reads the setting is read at its own `srt_server` block: the `recvlatency` it writes, or SRS's 120 where it writes none, shown as **Engine default** with the sentence that this stack version does not read the setting. The manager still writes `SRT_LATENCY` into the env file there, where nothing reads it.

For a deployment with its own config file, the manager reads `recvlatency` in that file, see [engine-config.md](engine-config.md).

## Restart, logs and effective config

`manager/src/domain/ContainerControl.ts` talks to Docker through the same socket the metrics collector uses. It finds a container by its two compose labels, the deployment's project and the service.

- **Restart** works on `RESTARTABLE_SERVICES`: `srs`, `ome`, `stream-uploader` and `bee-uploader`. It calls Docker's restart with a stop timeout of `RESTART_TIMEOUT_SECONDS` (10). The deployment's status does not change, and an `engine.restarted` event is published. It is refused while the deployment is deploying, stopping or being removed, and while a restart of the same service is in flight or within its `RESTART_COOLDOWN_MS` (10 seconds) cooldown.
- **Logs** returns stdout and stderr with timestamps, demultiplexed, at most `MAX_LOG_LINES` (2000) lines. Chain endpoints in the text are reduced to their host, because Bee prints its endpoint on start and a key can sit in its path.
- **Effective config** reads `/usr/local/srs/conf/srs.conf` (SRS) or `/opt/ovenmediaengine/bin/origin_conf/Server.xml` (OME) from the running container, at most `MAX_CONFIG_BYTES` (256 KiB). The SRS config holds the SRT passphrase in clear, so the route logs who read which deployment's config and answers `no-store`.

## Routes

All routes need a signed-in session. The full reference is in [the API reference](../../manager/README.md).

| Method | Path                                                | Body                                                     | Answer                                                                                                       |
| ------ | --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET    | `/profiles/:name/engine`                            |                                                          | The engine, its settings, defaults and their sources, fields, readings, and `live: null` with the reason why |
| PUT    | `/profiles/:name/engine-settings`                   | The whole set of settings, optional `expectedInstanceId` | 202 and the deployment                                                                                       |
| POST   | `/profiles/:name/containers/:service/restart`       |                                                          | 202                                                                                                          |
| GET    | `/profiles/:name/containers/:service/logs?tail=200` |                                                          | `text/plain`                                                                                                 |
| GET    | `/profiles/:name/engine/config`                     |                                                          | `text/plain`, no-store                                                                                       |

`PUT /profiles/:name/engine-settings` is for scripts that want to save and recreate in one call. The console saves through the deployment's settings routes instead. Its body replaces the whole set, so an empty body puts every setting back to its default, and a key neither engine reads is refused by name with `validation_error`, without repeating its value. It always recreates the engine, and the stream uploader as well when a setting the uploader reads changed. It moves the same settings revision the Stack settings card saves under, and is refused with 409 `engine_settings_changed` when a save from the card landed after it read the settings.

| Refusal                        | When                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| 409 `profile_busy`             | The deployment is deploying, stopping or being removed.                                         |
| 409 `restart_in_progress`      | A restart of the same service is running or within its cooldown.                                |
| 409 `container_not_running`    | No container of that service is running.                                                        |
| 409 `engine_settings_changed`  | A save from the Stack settings card moved the settings revision.                                |
| 409 `profile_instance_changed` | `expectedInstanceId` names a deployment that was removed and created again under the same name. |
