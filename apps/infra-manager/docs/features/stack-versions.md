# Stack versions

A stack version is one release of the streaming stack (`apps/hls-stream`) that the manager can deploy. This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys the stack onto hosts. The manager records which version each deployment uses, the build that version publishes, and the build each running service was actually started from.

## What it does

- A **version** is a named git ref (a branch, a tag or a commit) of a repository the manager is allowed to build from. Each version has a row in the manager's database.
- A **build** is the stack tree of one commit, fetched and prepared on the host, with a manifest that names its commit and build id. A published build is never written to again.
- The **bundled version** is the stack of the commit the manager itself was deployed from. Every manager has it. It is built on the host the same way as any other version.
- A version's **contract** is what the manager reads out of its build: ports, slot limits, required secret names, engine defaults, which keys each container reads, and which optional features the version supports.
- A deployment does not run inside the build. It runs from an **execution copy**, a private copy of the build it was admitted on.

## Selecting a version

New standalone deployments and groups choose a version in the new-deployment wizard. The default version is the initial choice when it is available. If there is no available default, you choose one, even when only one other version is available.

A version list that arrives late still leaves a usable selector. A later change of default does not overwrite a choice you made or discard the draft. If the selected version disappears, you choose again.

Updating a version does not restart its deployments. The build a version publishes and the build a deployment runs are separate facts. A deployment moves to the new build on its own next deploy.

## Versions page

The **Versions** page lists the bundled version and every added version. Each card shows the version name, its ref, the repository and folder its stack came from, the commit, the build state, whether it is the default and whether it is **Tested**. Details expand for the contract and build information. The actions stay reachable at narrow widths.

- **Add** registers a ref and starts its build. The build log streams progress and failures to the page.
- **Update** fetches and builds the version's ref again. On the bundled version it builds the commit the manager pins and moves that version's ref onto the pin. A failed update keeps the previous usable build and records the failure. A version with no usable build stays failed.
- **Settings** opens the page for that version's own files, see [Settings for one version](#settings-for-one-version). It is disabled for a version that has not finished a build on this host and for a version that still deploys from a flat checkout. The button says which of the two applies.
- **Tested** records that you approve the build shown on the card. It runs no tests and does not prove live playback.
- **Set as default** makes the version the wizard's initial choice. A version must be Ready and Tested before it can become the default.
- **Remove** refuses the bundled version, the default, a version that is building, a version any deployment uses, and a version still held by jobs, observations, operations or execution copies. The refusal names what still holds it.

Only one build runs at a time on a host. Add, Update and Apply take the same lock. A second one is refused while the first runs, with the name of the version that holds the lock.

Adding a version runs that repository's build and deploy code with the manager's privileges. Add only sources you trust.

### Release

Each card shows, under **Release** beside the build, the release its current build was made as: the label and the first nine characters of the commit, such as `v3.4 (635b4e175)`, or the label alone when it already starts with those nine characters. The whole commit is the element's title. A build made with no release shows no such row. The same rule, `buildLabelText` in `common/src/buildLabel.ts`, shows a release everywhere in the console, and the player uses it too, see [The player's release](#the-players-release).

A build carries its release in its own manifest, `label` in `.stack-manifest.json`, written once when the build is made. `GET /versions` answers it as `buildLabel`, read from the manifest of the build each row deploys from. It is null for a version on a flat checkout and for a build made with no label. Where the label comes from depends on the version:

- **The bundled version** takes the label the manager was deployed with, from the API's `MANAGER_VERSION` environment variable. A value outside `^[A-Za-z0-9._+/-]{1,96}$` (`VERSION_LABEL_RE`) or no value at all makes the build without a label. A manager deploy that changes only the manager builds nothing, so the bundled build keeps the label it was made with.
- **An added version** takes the tag on the commit it built, read in that version's own clone once the build is done. The order is: the newest annotated tag on the commit, then the newest lightweight tag, then the nearest tag behind it with the number of commits past it, such as `v3.4+3`, then none. A tag name outside `^[A-Za-z0-9][A-Za-z0-9._+/-]*$` or longer than `TAG_NAME_MAX_LENGTH` (80) characters is passed over at every step. These rules live in `manager/src/domain/versions/buildLabel.ts`. No short commit stands in for a missing tag, and no label ends in `-dirty`.
- Every fetch of a build brings the repository's tags along, and a version that already has a clone takes the remote's tags as they are now. A tag moved upstream follows, and a deleted one goes. The ref is fetched after the tags, so the build checks out what the ref names. A clone git cannot read leaves the build without a release, and the log says why. The build publishes all the same.
- An Update that reuses a complete build of the same commit and settings keeps that build's release. **Apply** on the settings page makes a build that keeps the release of the build it was made from, as it keeps its commit and toolchain.

## Where a version comes from

A version is fetched from the first repository in the `STACK_SOURCES` setting of the manager. When `STACK_SOURCES` is unset, the list is this monorepo first and the stack's earlier standalone repository, `swarm-hls-stream`, second (`DEFAULT_STACK_SOURCES` in `manager/src/domain/versions/stackSources.ts`). You add a version by its ref alone.

For each commit the build script decides where the stack sits: `apps/hls-stream` for a commit of the monorepo, and the whole tree for a commit of the stack's own history, which the monorepo holds under the same commit ids up to `STACK_IMPORT_HEAD`. A commit that holds neither is refused before any of it runs. A branch of the monorepo and an older release of the stack, by its commit or its tag, can both be added.

Each row records the repository it is fetched from and the folder its current build took the stack from. The folder changes only when a build publishes. A version built from `swarm-hls-stream` keeps building from there on Update. A row naming a repository that is not in `STACK_SOURCES` is refused on Update before anything runs.

A folder is exported with the same bytes and file times an export of the whole tree would give, because the build script archives the commit narrowed to the folder.

`STACK_SOURCES` is a comma separated list. Each entry is `https://github.com/<owner>/<repo>.git`, optionally followed by `#<folder>`, where `.` means the whole tree. An entry without a folder is laid out like the monorepo. A malformed value stops the manager at startup.

## Tested and default are separate

Approval names both the commit and the build id shown on the card. The database checks those, the layout and the Ready status in the same write, so a stale page cannot approve a different build of the same commit. A build without that identity cannot be approved. A version on a flat checkout, which has no build id, is approved by its commit alone.

When an update changes the approved build, approval is cleared. If that version was the default, it stays the default, and the wizard shows that it is no longer marked as tested, with the date the update cleared it. Approving again, or withdrawing approval by hand, clears that date.

Publishing the identical approved build again keeps approval. A distinct rebuild has a distinct identity and needs its own approval.

## Published builds and retained roots

Under `STACK_VERSIONS_ROOT`, a version uses these sibling paths:

| Path                                      | Purpose                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `<name>.repo/`                            | The source clone used to prepare builds                                                                |
| `<name>.builds/<build-id>/`               | A published build                                                                                      |
| `<name>.builds/tmp-<attempt>/`            | One attempt's unpublished staging tree                                                                 |
| `<name>.builds/<build-id>.inventory.json` | The build's inventory, hashed once, so a deployment's copy can be checked by a stat walk               |
| `<name>/`                                 | The settings files you own, and the flat checkout of a version that has no builds                      |
| `.executions/<execution-id>/tree/`        | One deployment's private copy of the build it is running, with `owner.json` and `ready.json` beside it |

A published build carries `.stack-manifest.json` and a `.complete` marker written last. Its identity is its commit and build id. A build of the same commit and inputs reuses the existing complete build. A distinct rebuild gets an id such as `<commit>-r1`. A published build is never replaced in place.

A saved setting reaches a deployment only through a build that captured it. **Apply** on the settings page therefore publishes another build of the same commit instead of fetching and building the stack again: the current build's tree with the settings files replaced by the committed revision, a fresh build id, the old manifest's commit and toolchain, and the revision's generation and hashes. Unchanged files are hard linked, and copied where the filesystem refuses a link. A symbolic link in the source tree is recreated as a link. The deployment env file is copied rather than linked, because a deploy truncates it in place. When a build of that commit already carries that revision, Apply answers that build and publishes nothing.

The database row points at the active build. Publication updates it atomically and keeps the previous build.

A deployment captures its build before running any script. Admission validates the selected build under the version row's lock and records a job reference before the build can be pruned. A changed, missing or incomplete build is refused. The deployment does not switch to a newer build or fall back to the bundled checkout.

Pruning keeps the current and previous builds, builds of unresolved jobs, builds named by observed services, and builds open operations still need. A failed script or an unavailable container observation does not count as proof that a build can be released.

Removing a version rechecks its identity and every hold while it locks the version's row. File cleanup starts only after those checks pass. Before it deletes anything, the manager writes a `<name>.removal.json` marker beside the version. A crash or partial cleanup leaves the marker in place, so the row cannot become deployable again. Updates, deployment admission and execution copies refuse a marked version. Retrying the removal finishes the cleanup. The marker stays after a successful removal. A new version of the same name is allowed only when the marker is valid and belongs to an older version id. An unreadable, malformed, active or newer marker is refused. Every configured path must stay inside the verified versions directory.

## Host configuration and runtime files

Every version keeps three kinds of file that you own, in `<name>/`: the base `.env`, `deploy/config.json`, and one `.env` per engine the version ships a sample for. The settings page and `manager/scripts/stack-config-edit.sh` commit them as one revision under a shared lock. Each file is replaced atomically, and the revision manifest with their hashes is written last.

A version's first build seeds those files from the samples in the build, so an added version starts with the stack's own defaults. Then every env file is completed from the sample of the version being built: the sample's line for each key the file lacks is appended, in the sample's order, as one more revision. A key you already set keeps its bytes. A value the sample leaves blank stays blank.

On a host whose bundled stack still has a legacy flat tree (`BUNDLED_STACK_ROOT`), the bundled version's first build takes `.env`, `deploy/config.json` and the engine envs from that tree, byte for byte, as its first revision. The legacy tree is only read, because the engines of deployments that still run from it mount it. A config root that already holds settings is left alone.

A build or a deploy takes the same lock and checks what it captured against that revision. An edit that is not finished produces a refusal rather than a mix of old and new files. A root without a revision manifest is adopted from its current files.

These files carry the stream passphrase, the API token, the webhook token and the Bee passphrase. Every file the manager writes into a config root or a build is owner only, and a file it replaces keeps the mode you gave it. Every path of the set is checked for links before it is read.

No credential is returned in the version list or printed in a build log. The settings page is the one route that answers these values, and the manager logs key names only.

## The tree a deployment runs in

A deploy copies the build it was admitted on into a directory of its own under `.executions`, registered against the job reference the deploy already holds, and runs the stack's scripts there. The env files the deploy and the stack's scripts write land in that copy, so a published build keeps its bytes however many deployments run from it. Stop, health and remove run in the same copy.

The copy's files are hard links to the build's own files. The files a deployment writes are ones the build does not have, so the two share the bytes of everything else. A copy costs the disk a few kilobytes of directories, and preparing it is a walk of the tree rather than a write of every byte. Where the filesystem refuses a link, because the executions directory sits on another volume from the builds, the bytes are copied instead.

The copy is checked without reading the build again:

- The first time anything copies a build, the build is read and hashed with sha256 into `<build-id>.inventory.json` beside it, owner only. The record holds the tree digest and, for every path, its type, mode, file digest or link target, and a stamp of device, inode, mode, size and modification time.
- Before and after the links are made, the build is checked against that record by a stat walk. A build that changes under the copy is refused.
- The finished copy is checked by identity. A linked path whose device and inode differ from the record is refused.
- Only the files the copy owns outright are read and hashed: the settings files, every file on a host where linking is refused, and a file named `__proto__`.
- A build that has no record gets one on its first deploy, and the log says so.

The stamp leaves out the status-change time and the link count, because making a hard link changes both without changing a byte.

While a build or a linked copy is inventoried, each regular file is held to its device, inode, type, mode, size and modification time across the read. Directories, symbolic links, path membership and link targets are checked strictly. The manifest is parsed from the bytes read under that identity. Another deployment can create or remove a hard link at the same time without failing this deployment. Inside one manager process, simultaneous first inventories of the same build share one hash. All waiters see a shared failure, and the next call starts a fresh attempt.

A record is believed only while it describes the build under it. A record that does not parse, names another build, has a digest that does not match its own entries, has stamps and entries that disagree, or stamps a build directory that is not the one there now, is treated as absent and taken again. Prune removes a build's record with the build.

Preparing a copy logs which build it copies and how many files that is. A copy of more than `PROGRESS_FLOOR` (500) files logs ten progress lines while it links them.

The directories are owner only. The engines mount files out of the copy read only: the SRS compose file mounts its config template, entrypoint and healthcheck, and the OvenMediaEngine one mounts its `Server.xml` template and entrypoint. Read only matters, because those files share their inodes with the build. A version that keeps no immutable builds gets no copy and runs from its flat tree.

### When a copy is removed

A copy is recorded as launched before anything can start from it. A deployment keeps the copy it runs from and the one before it while a deploy is in flight, so a deploy that fails leaves the tree that last worked. After a successful deploy it keeps one, and a removed deployment keeps none. A copy nothing ever ran from is removed with its failed deploy or at the next boot.

A launched copy is removed only when the deployment has a newer launched copy or has been removed, the copy's job has finished, no deploy attempt for the deployment is open, and a complete Docker observation of the local host finds no container that mounts it, runs in it or depends on it. When the observation is incomplete or any container's dependency is unknown, the copy is kept. A copy on a remote target is always kept, because its files live on another host that the manager cannot inspect this way. Removing a copy releases its hold on the build.

## Settings for one version

**Settings** on a version card opens `#/versions/<id>/settings`, one section per file, in the order base env, deploy config, engines.

The page masks a secret until you choose **Reveal**, marks a value that still equals the version's sample with `default`, and says under a generated key that the manager fills it per deployment unless a value is set here. That is the rule the deploy follows: a required secret that the version's base or engine env already sets is neither generated nor written, so the file's line reaches the containers. An empty one is generated per deployment. A value already recorded for a running deployment wins over both, so a running container's token is not rotated by a settings change. A value the deployment stores on its own **Stack settings** card wins over all of them, see [deployment-settings.md](deployment-settings.md).

A save keeps every byte you did not change, because these files carry the host's own documentation in their comments and can also be edited over ssh. An env file is rewritten from its current bytes: each key the save names has its value replaced in place, keeping any `export` prefix, the spacing up to the equals sign and a trailing carriage return. Every comment, blank line and untouched line is copied through, and a key the file does not have is appended. The deploy config is edited as text, with a **Reset to sample** action.

The values come back in the clear, secrets included. The routes are behind the session gate, and a value you cannot see is one you cannot check. Any signed-in account can reach this page, as with every other version route.

## Routes

All version routes are behind the session gate. The full reference is in [the API reference](../../manager/README.md).

| Method | Path                           | Body                             | Answer                                                     |
| ------ | ------------------------------ | -------------------------------- | ---------------------------------------------------------- |
| GET    | `/versions`                    |                                  | The versions, with `buildLabel` on each                    |
| POST   | `/versions`                    | `{ name, ref }`                  | The build log as a server-sent event stream                |
| POST   | `/versions/:id/update`         |                                  | The build log as a server-sent event stream                |
| PATCH  | `/versions/:id`                | `{ tested, commitSha, buildId }` | The version                                                |
| POST   | `/versions/:id/default`        |                                  | 204                                                        |
| DELETE | `/versions/:id`                |                                  | 204                                                        |
| GET    | `/versions/:id/settings`       |                                  | The version's own files with the sample's notes, no-store  |
| PUT    | `/versions/:id/settings`       | `{ expectedGeneration, files }`  | `{ generation }`, the new revision                         |
| POST   | `/versions/:id/settings/apply` |                                  | `{ buildId, reused }`, the build that carries the settings |

`GET /versions/:id/settings` answers every key with the comment block the sample keeps above it, the value the sample assigns, and two flags: whether the key is secret and whether the manager fills it per deployment.

`PUT /versions/:id/settings` commits the whole edit as one revision under a single hold of the edit lock. One save carries at most `MAX_SETTINGS_FILES` (16) files and at most `MAX_SETTINGS_ENTRIES` (512) keys in any one of them, and names each file once.

| Refusal                      | When                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 409 `settings_changed`       | The save names a revision that has moved. The answer carries the `generation` to reload.                               |
| 409 `settings_locked`        | Another edit holds the lock.                                                                                           |
| 409 `settings_not_ready`     | The version has not finished a build, or still deploys from a flat checkout and has no build to make another one from. |
| 409 `stack_build_busy`       | Another build holds the build lock.                                                                                    |
| 409 `stack_version_untested` | Set as default on a version that is not Tested.                                                                        |

## The bundled version

The bundled version is the stack commit the manager pins. The host fetches and builds it the same way as an added version.

A manager deploy does not carry the stack. It writes into `manager/.stack-commit` the last commit that changed `apps/hls-stream`, which holds the same stack as the commit being deployed. A deploy that changes only the manager finds the bundled build it already has, builds nothing and keeps the Tested mark. The deploy refuses a commit that no remote branch holds, because the host fetches it from GitHub.

The API reads the pin at boot. When the bundled row is not on a complete build of it, boot builds that commit through the same build script, the same build lock and the same log on the Versions page. **Update** on the bundled card builds the pin again. A manager with no pin, such as a developer checkout, keeps the row on the tree in its checkout and refuses the rebuild with a plain reason.

A build the lock refuses, and a build script that cannot start, write their reason into the row and move the row onto the pin. A version that still has a build stays ready with the reason beside it. A version with nothing to deploy from is failed. A pin file that holds something other than a commit is logged, and recorded on the row only when the row has no build to fall back on.

A deployment that still runs from the bundled version's legacy flat tree keeps running from it until its own next deploy moves it onto a build. Updating the manager does not restart those deployments or discard their data.

The upgrade command on the host holds one directory under the versions root for its whole run. It goes through the steps checking, stopping, migrating, starting and verifying, then waits a bounded time for the API's boot to reach a build of the pin. A build that failed or timed out is printed and the command exits non zero, after it releases the directory, because the manager is up by then.

## Contracts, targets and shared image names

The manager reads ports, slot limits, required secret names, engine defaults and supported features from the selected version's contract. The features include `engineConfig`, whether a deployment can use its own engine config file (see [engine-config.md](engine-config.md)), and `playerRelease`, whether the version's deploy script takes the release of the build it deploys. Unknown or unreadable allocation information causes a refusal rather than an invented port plan.

The contract also records which settings each container reads: every `${KEY}` its block in the version's compose files names. A changed setting then recreates only the containers that read it. A version whose contract lacks this list uses the manager's own shorter list.

A version's slots are capped at the lower of its declared maximum and `MANAGER_SLOT_CAP` (100). A stopped deployment keeps its slot. Ports are reserved per Docker daemon, transport and port, and a stopped deployment keeps its reservations. Target checks and observed bindings decide ownership and release, not a script's exit code alone.

A version that builds shared image tags is admitted under the shared image guard. An unresolved deploy attempt blocks a conflicting deployment until it is resolved, and the console names that attempt. A refusal is not queued and is not retried. The **Deploy attempts** card on the Versions page lists the attempts that still hold something. An attempt whose script ended without the manager judging it offers **Release**, which you use after checking the host.

## What is actually running

A version's current commit does not prove which code every service runs. Service observations record each container's build and image. A deployment shows one commit only when its services agree. Otherwise it shows the mixed state. A partial deployment does not move untouched services to the new build.

`last_full_deploy_commit` records a verified full deployment. It does not replace per-service evidence or prove that receiving, publishing or playback work.

The same observation reads the release each container's build was made as, from the manifest of the tree the container started from. For an execution copy that is the manifest of the build it was copied from. It is kept in `containers.build_label`, and `GET /profiles` answers it as `buildLabel` on each container.

A deployment's page shows it in the **At a glance** card, below the commit its containers run, when every container runs one commit under one label. It is labelled **Player** on a deployment that serves the web player, because that is the player its viewers load, and **Release** on any other. It can be older than the release on the version's card, because an update moves the version and only a deploy moves the containers. Nothing is shown for a build made with no label, before the deployment has been observed, or when the containers disagree.

The release is shown to signed-in users only, and the routes that answer it are behind the session gate.

## The player's release

The player names the release it was built as in its QoE overlay, which `?qoe=1` on a watch URL opens, for example `Player v3.4 (1702aff1b)`, by the same display rule as the console, with the whole commit as the line's title. Nothing else in the player shows it. A player built with no release shows no release line.

A deploy reads the label and commit from the manifest of the build it was admitted on and passes them to the stack's deploy script as `--release-label` and `--release-commit`. The script builds them into the client as `VITE_APP_RELEASE_LABEL` and `VITE_APP_RELEASE_COMMIT`. Once the deploy is observed, the overlay names the same release as the At a glance card. A build with no label passes neither flag, and a manifest commit shorter than 40 characters is left out, so the overlay shows the label alone. The script writes them only for a target that builds the client. Stop and health never receive them. The script holds the label to `^[A-Za-z0-9._+/-]{1,96}$` and the commit to `^[0-9a-f]{40}$`, refuses anything else before it deploys, and writes both empty without the flags. The player prints them as text.

The flags go only to a version whose contract has `playerRelease`. A version whose deploy script has no case arm for both `--release-label=*` and `--release-commit=*` in `_lib.sh` would read an unknown flag as a service name and refuse the deploy, so such a version is given only the arguments it knows, and its player shows no release. A stored contract with no such field reads as false until a build reads the contract again. The version card's contract line says `player shows its release` on a version that has it.

## Limits

- An existing deployment or group cannot yet move to another version. Version selection applies to new deployments only.
- The inventory stamps do not detect a writer who changes a file of a published build and then restores its size, mode and modification time. Such a writer already has write access to the versions root.
- After a build's first deploy nothing reads its bytes again, so a byte that rots on disk under it goes unnoticed.
- A write through one of a copy's linked paths after the build's last stat walk reaches the build through the shared inode without the copy seeing it. The window is milliseconds, inside an owner only directory nothing has started from yet.
- When the executions directory and the builds sit on different volumes, every file of a build is copied and read on every deploy.
- Any signed-in account can read and change a version's settings, secrets included. There is no narrower role for this page yet.
- Execution copies on a remote target are never removed by the manager.
