# Engine configuration

Engine configuration lets one deployment run its own SRS or OvenMediaEngine config file instead of the template its stack version ships. This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys the streaming stack (`apps/hls-stream`) onto hosts. The manager checks the file, recreates the engine, watches it start, and records the outcome. A saved file is not proof that publishing or playback works.

## What it does

- The **engine** is the deployment's media server, SRS or OvenMediaEngine (OME). See [engine-control.md](engine-control.md).
- The **template** is the config file the stack version ships for that engine. The engine's entrypoint fills its **placeholders**, such as `SRT_LATENCY_PLACEHOLDER`, from environment variables at container start.
- A **custom file** is the deployment's own config, stored in the manager's database in place of the template.
- A **rollout** is one apply or reset of a custom file, stored as an operation with a state.

Support comes from the version contract's `engineConfig` flag for each engine. A version name alone does not prove support. See [Stack versions](stack-versions.md).

## How to use it in the console

On the deployment page, the Engine card's **Config file** button opens the editor. It shows the version's template, or the stored custom file when there is one, in a plain text area. The editor takes at most `ENGINE_CONFIG_MAX_BYTES` (128 KiB) of nonempty UTF-8 text.

- **Check and apply** checks the file, stores it and recreates the engine on it.
- **Back to the template** removes the custom file and recreates the engine from the version's template.
- **Verify now** and **Back to the previous file** appear on the Engine card when a rollout needs them, see [States](#states). They are not offered for a stopped deployment, and the card says why when they are unavailable.

Keep placeholders for every value the stack manages, such as generated credentials, callback addresses and ports. A custom file is stored as text, so a literal that replaces a placeholder is stored as that literal. Keep each placeholder on a line of its own: the entrypoint fills only the first placeholder on a line, so a second one reaches the engine as the placeholder text itself. A line that carries the SRT latency placeholder twice is shown as **Unverified**.

## What the Engine card reads from a file

The Engine card and the **At a glance** summary show each configured value with its source. For a setting read from the environment, the manager combines the version's defaults, valid host overrides and the deployment's own values. A value the manager can read reliably as a literal in the file is labelled **Set in config file**. Changing the deployment's setting does not change that literal, and the setting's row in the Stack settings card says a value there has no effect until the file reads the placeholder again.

An omitted setting is **Not specified**. Conflicting values, unsupported syntax and other uncertain readings are **Unverified**, with a reason. The manager reads all relevant sections together instead of taking the first value it finds. Generated SRS sections can prevent a reliable reading of the fields they control. OME's uploader poll interval is read from the environment, not from the XML. These readings describe the configured file, not what the running engine loaded. The running config is under **Logs**, on the **Effective config** tab.

- **SRT latency.** In a custom SRS file it is read at `recvlatency` in `srt_server`, the directive that decides SRS's wait on ingest. A literal there is **Set in config file**. A block with no `recvlatency` is shown as SRS's own 120 milliseconds, labelled **Engine default**, with one sentence saying why, and changing the setting does not change it. A file that carries only the `latency` placeholder therefore reads as 120. [engine-control.md](engine-control.md) explains how SRS applies the two directives.
- **ABR rung sizes and bitrates.** The rung settings have no placeholder of their own. The stack reads them as one key, `ABR_LADDER`, which the entrypoint turns into the generated transcode block. The Engine card shows them as **Unverified** in every config, because the manager does not read sizes or bitrates out of an `engine` block. A custom file that writes its own `engine` blocks encodes at the sizes it writes, whatever the rung settings say, while the uploader still describes each rung from `ABR_LADDER`. See [Each rung's size and bitrate](abr-ladder.md#each-rungs-size-and-bitrate).

When the page receives a changed deployment or configuration revision, the Engine card hides old readings at once. A failed or timed-out refresh does not bring stale values back.

## What validation establishes

| Engine          | Before recreation                                                                                                                                                                                                       | After recreation                                                                                                                                             | What a pass does not establish                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| SRS             | The selected image's `srs -t -c` parses a temporary copy with dummy placeholder values. Each check owns its temporary directory and mounts its file read only with `--mount`, so one check cannot touch another's file. | The manager watches the recreated container for 20 seconds (`DEFAULT_ENGINE_WATCH`), checking its identity, running state and restart count every 2 seconds. | Successful ingest, uploader admission, Swarm delivery or playback.                   |
| OvenMediaEngine | Strict XML parsing, and a comparison against protected paths and values from the version's own template. This is the manager's check, not OME's own parser.                                                             | The same startup watch, then a TCP reachability check of the mapped HLS port from the manager, with a 10 second budget.                                      | A working admission callback, a usable stream or playlist, or end-to-end publishing. |

OME's protected set includes placeholder-bearing elements, bind ports, admission providers, application names, provider and publisher element names, and output stream mappings. Paths, values and multiplicity must match the version's template. Sibling order can differ. A setting mapped to an engine setting, such as segment duration or count, can replace its placeholder with a literal that passes the same field validation.

The manager refuses a changed callback route even when every placeholder is kept, malformed XML, duplicate protected structures, and a faithful copy beside a changed duplicate. OME itself tolerates some malformed XML and exits on other kinds, so the manager refuses all of it before recreation. Removing admission callbacks is not an access-control measure. It can bypass the uploader's admission workflow.

A failed OME TCP connection is a diagnostic about reachability. If the engine stayed running, that failure alone does not prove the file is bad and does not trigger a revert. The card keeps the diagnostic. An `applied` rollout means these bounded checks completed. It is not a verdict that publishing works.

## Rollouts and recovery

Every apply or reset is a stored operation. It records the deployment's lifetime identity, its configuration and intent revisions, the previous file, the container identity and the current state. The lifetime identity changes when a deployment is removed and created again, even under the same name.

Apply, reset and recovery take one atomic claim on the configuration operation and the deployment. They carry the captured build through execution and check ownership again when they record completion. A failure during preparation leaves the operation `interrupted`, with its previous file and its original failure. A refused recovery claim does not mean the previous file was restored.

Startup verification begins after the engine is recreated and the deployment is `RUNNING`. A stopped engine, a restart or another startup failure can trigger one recovery attempt with the previous file. Every recovery step checks that the operation still owns the same deployment and revisions. A newer edit, stop, start, removal or replacement supersedes the old operation, and an old watcher does not undo the newer action.

The stack can also refuse its own startup command before the deployment reaches `RUNNING`. That is an apply failure. If recovery then recreates the previous file, the deployment is `RUNNING` again while the operation stays `failed`, its reason says the previous file is back, and the card offers **Verify now**. A failure the manager's watch detects later ends `reverted` when the same recovery succeeds. The two states tell you where the file failed.

### States

| State         | Meaning and next action                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applying`    | The operation is storing the file or template and recreating the engine. Wait for its outcome.                                                                                        |
| `watching`    | Recreation completed and startup verification is running.                                                                                                                             |
| `applied`     | The checks completed. A reset to the template completes after recreation without a watch. Read any OME reachability diagnostic separately.                                            |
| `reverting`   | Recovery is restoring the previous file and recreating the engine.                                                                                                                    |
| `reverted`    | The new file failed startup verification and the engine was recreated on the previous file.                                                                                           |
| `failed`      | Applying the file failed. Read the recorded reason, which also reports a failed recovery. **Verify now** starts another attempt.                                                      |
| `interrupted` | The manager could not finish verification or recovery. **Verify now** recreates on the stored file. **Back to the previous file** uses the file saved by the interrupted operation.   |
| `superseded`  | A newer action or container took over. The old operation does no more recovery, and the card says the last file was not verified. **Verify now** starts an attempt on what is stored. |

The Engine card and an open editor follow the stored state. Recreating on the previous file can itself fail and leave the deployment in `ERROR`. There is no promise of uninterrupted service or guaranteed restoration.

After a manager restart, an unfinished apply or recovery becomes `interrupted`. For a saved watch, the manager checks ownership and container identity again. The same running container with zero restarts starts a fresh full watch. A demonstrated failure can take the recovery path. A replacement container supersedes the watch. An inspection outage leaves the result `interrupted`, never verified. A stopped deployment is not restarted by this.

## Persistence

The database stores the custom file and the operation history. Deployment preparation writes the custom file into the deployment's data directory. Backing up the manager's files alone does not back up this state. Removing a deployment removes its data in the normal removal flow.

## Routes

All routes need a signed-in session. The full reference is in [the API reference](../../manager/README.md).

| Method | Path                                             | Body                  | Answer                                                                                                            |
| ------ | ------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/engine-config`                  |                       | `{ engine, supported, unsupportedReason, config, template, placeholders, ... }` with the latest rollout, no-store |
| PUT    | `/profiles/:name/engine-config`                  | `{ "config": "..." }` | 202 and a deployment snapshot                                                                                     |
| DELETE | `/profiles/:name/engine-config`                  |                       | 202 and a deployment snapshot                                                                                     |
| POST   | `/profiles/:name/engine-config/verify`           |                       | 202 and a deployment snapshot                                                                                     |
| POST   | `/profiles/:name/engine-config/restore-previous` |                       | 202 and a deployment snapshot                                                                                     |

A 202 means the recreation was accepted. Read the operation's later state for its outcome. A successful HTTP answer does not prove playback.

## Limits

- An existing deployment cannot yet move to another stack version, so a custom file stays tied to the version it was written for.
- The checks do not prove that a stream publishes, reaches Swarm or plays. They are bounded parse, start and reachability checks.
- OME validation is the manager's own XML check, not OME's parser.
- Recovery restores the previous file at most once per rollout, and that recovery can fail.
- The Engine card reads the configured file, not what the running engine loaded.
