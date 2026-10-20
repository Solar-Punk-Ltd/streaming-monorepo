# A deployment's own settings

A deployment's own settings are the values one deployment uses for every key its stack version declares, with the version's value as the default. This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys the streaming stack (`apps/hls-stream`) onto hosts.

## What it does

- A **key** is one setting the stack reads from its env files, such as `HLS_WINDOW` or `ADMIN_API_URL`. The version's samples declare which keys exist, with a comment block that describes each one.
- A deployment's own value goes into its env file, `.env.<name>`, over the version's base `.env`. The manager's own lines are written after it, so a stored value never replaces a key the manager computes.
- The deployment's **engine settings**, the media server's segment length, playlist window, SRT latency and the rest, are in the same list, so a deployment has one list of settings. See [engine-control.md](engine-control.md) for what each one does.
- A **save** stores values and changes nothing that runs. **Apply** recreates the containers that are behind on what was saved.

## Where a value comes from

Each key says where the value its next deploy writes comes from:

| Source          | Meaning                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deployment      | Stored for this deployment.                                                                                                                             |
| version         | Set by the version's build, in its base or its engine env file. For an engine setting, also what the version falls back to where the host sets nothing. |
| manager-default | An engine setting's default that is the manager's own, such as the SRT latency's 2000.                                                                  |
| manager         | Decided by one of the deployment's own controls, named on the key.                                                                                      |
| generated       | A secret the manager generated for this deployment.                                                                                                     |
| unset           | Set by nothing, so the stack's own default applies.                                                                                                     |

The controls that decide a key are: the services the deployment runs, its postage stamp, its node pool (on an ABR uploader its rung settings decide `ABR_LADDER` instead), its chain endpoint and the gateway's node mode, its Bee URL, its SRT passphrase, its feed key, owner and topic, the engine's own config file, the port slot, and on the manager's own host the data directories. A save that names one of those keys is refused with the control named. A value stored for such a key is left out of the env file and named in the log.

A generated secret is the exception. A value stored for it replaces the generated one, and the generated one is kept for when the value is reset.

## The engine settings

Every engine setting the deployment reads is listed as its own to set, whether the version's samples declare it or not, in the order of the engine's field list: for SRS the segment length, the force-close ceiling, the playlist window and the SRT latency, and on an ABR uploader the seven transcoding settings and each rung's width, height and bitrate. For OvenMediaEngine they are the segment duration and count and the uploader's poll interval. The field list is `common/src/engineSettings.ts`, and the page takes each setting's label, unit, help, kind, bounds and choices from it.

- **Its value** is what the deployment stores in `profiles.engine_settings`. **Its default** is what an unset one falls back to on the deployment's host, as the Engine card names it: the host's base `.env` first, then the version's own fallback. The SRT latency's 2000 and the segment length's 2 are the manager's own, and so is the shipped rung ladder, which the host's base `.env` cannot set.
- **A rung setting** is never written as a line of its own. The deploy composes `ABR_LADDER` from the twelve of them. The `ABR_LADDER` row stays read only on an ABR uploader, shows the value the deployment gets and says it is built from the rung settings. A change to a rung recreates the engine and the uploader, which both read that key. See [Each rung's size and bitrate](abr-ladder.md#each-rungs-size-and-bitrate).
- **A key the engine's running config does not read**, because the deployment's own config file dropped its placeholder or the version's template never takes it, says on its row that a value there has no effect.
- **An engine setting the deployment does not read** is listed out of reach with the reason wherever a sample declares it: a rung setting on a deployment that does not encode the ABR ladder, and a setting of the engine it does not run. A value stored for one is listed so it can be reset.

A save puts an engine key in `profiles.engine_settings`, never in the stack columns. Each value is held to its field and refused by key in the engine's own words. The engine settings as they will be after the save, with the host's default for any key nothing stores, are then held to the engine's own rules. A pair the engine would refuse is refused with that sentence: a force-close ceiling under the segment length, a frame rate and segment length whose product is not a whole number, or a ladder rung no taller or no dearer than the one below it. A save that names no engine setting is not held to these rules. The stack columns, the engine settings and the revision change in one statement, so a save lands whole or not at all.

Turning the ABR ladder off in the deployment's **Edit** drawer removes the ladder-only settings, the transcoding settings and the rung settings, by key, so a value saved from the card while that edit was on its way stays.

The host can stop accepting engine settings it accepted when they were saved. A change to its base `.env` or to the version's fallback can drop the ceiling under a saved segment length, and turning the ABR ladder on can put a saved segment length under the keyframe rule. The deploy refuses such settings with the engine's sentence. The list still answers, with that sentence as `engineSettingsProblem`, and the card names it above **Save**. A save that names no engine setting is still taken, and a save that names one is taken once it leaves the set valid, which is how such settings get fixed. Apply is refused with the sentence rather than starting a deploy that would fail.

Apply recreates the containers that read what changed: the engine for an engine setting, the engine and the uploader for the segment length, which both read, and the uploader alone for the OvenMediaEngine poll interval, which only the uploader reads.

The engine settings route, `PUT /profiles/:name/engine-settings`, is for scripts that save and recreate in one call, see [engine-control.md](engine-control.md#routes). It moves the same revision as this card and reads the stored settings with that revision before it writes. It is refused with `engine_settings_changed` when a save from the card landed in between, and a page that read before it is refused with `deployment_settings_changed`. Neither save overwrites the other unseen.

## What is never shown

A secret, anything the settings page masks, is never answered, only whether one is stored. A chain endpoint is answered by its host alone, because its path or user info can carry a provider's key. The log names the keys a save changed and never a value.

## Where they are kept

On the deployment's row: plain values in `profiles.stack_settings`, secret ones in `profiles.stack_settings_secret`, the revision a save names in `profiles.settings_revision`, and the engine settings in `profiles.engine_settings`. Neither stack column is among the profile columns every page and event carries. A container record keeps a salt and digests in `containers.env_salt` and `containers.env_digests`.

## Behind, and Apply

Every successful deploy records, per container it started, a salted digest of every key that container's compose block reads. It also records the keys the version declares that only the deploy scripts read, unset keys included. The list compares those records with what the next deploy would write, and says for each key whether the running containers are behind:

- **same**: the running container got this value.
- **differs**: it got another one.
- **unknown**: no record can tell, which is the case for a container started without these records.
- **not-running**: the deployment is stopped, or is deploying, stopping or being removed, so no container is compared.

Each key also carries `runningValue`, the value the running containers that read it were started with, as their records keep it in clear. It is null for a secret and a chain endpoint, which a record keeps as a digest alone, for a key started unset or that no record covers, for containers started with different values, and for a deployment that is not running. The Storage card reads it for `STAMP` and `BEE_PUBLISHERS` to mark the batch a running uploader pays with, which after **Use** is not yet the batch the deployment stores. See [postage-stamps.md](postage-stamps.md).

Apply redeploys only the containers that are behind. When a changed key reaches only the deploy scripts, it redeploys everything. A stopped deployment's **Start** uses the stored values anyway, so Apply refuses a stopped deployment. Apply is also refused, with the engine's own sentence, while the deploy would refuse the stored engine settings.

A save names the revision the page read, and a save made against an older one is refused. Two people editing at once cannot overwrite each other unseen.

## The shape a value may have

Every value follows the rules of the version settings page (see [stack-versions.md](stack-versions.md)), which keep out a value the stack's loader and the manager's parser would read differently. A value holds at most 8192 characters. For keys whose accepted values are known, such as the start gate mode, the chequebook floor and re-check interval, the stamp limits, the log level and format, the switches, and the two web2 admin keys, the value is also held to what the stack takes, in `common/src/stackSettingFields.ts`:

- a number to the stream uploader's own bounds,
- a choice or a switch to the values the stack's samples name,
- `ADMIN_API_URL` to an http or https address with a host and no user name, password or `#` part,
- `ADMIN_API_TOKEN` to at least 32 characters.

Any other key is plain text, checked by its container when it starts.

The two web2 admin keys also follow a rule together, because the uploader turns admin mode on from the address alone and then refuses to start without a token. A save that names either key and leaves an address with no token anywhere, stored, set by the version or generated, is refused with both keys named. A save of other keys is not held to it. A stored token goes only to the origin of the address it was stored for, so a save that moves `ADMIN_API_URL` to another origin must come with a new token or a cleared one, and a deploy that would give the uploader another origin is refused. [The web2 admin link](web2-admin-link.md) has the rest of that feature.

## The Stack settings card

A deployment's page shows these settings in a **Stack settings** card after the Engine card, across the whole main column. The Engine card's **Settings** button brings this card into view with the engine settings open and the first one focused. The SRT ingest card's step to raise the SRT latency brings the card into view at that setting.

The Engine card and the engine line of **At a glance** show the stored engine settings, so between a save and Apply they name a value the engine does not run yet. The page reads the list once for this card and both of those, and they mark every value the running containers are behind on as **saved, not applied**. A save that lands also reads the deployment's row again, so both show the value it stored. The list is read again whenever the deployment's status, its batch or its pool string changes, so a batch set with **Use** on the Storage card shows in the banner at once.

- **Sections.** Keys are folded by the sample's sections, in the order they first appear. The deployment's engine settings come first in an **Engine settings** section, and the keys the version does not declare, which the deployment still stores, come last in a section of their own. A section opens on a click. A search by key or description opens every matching section and keeps only the matching keys. A folded section's line counts its keys and says how many are unsaved, cannot be saved or are not applied.
- **Each key** shows its description, folded to its first words when long, and a field shaped by what it takes: a list for a choice, a switch for true or false, a number field with its bounds, and text otherwise. The version's value is beside it as the default, with a reset when the deployment stores a value. A changed key, and a saved one the containers do not have yet, is marked with the services that applying it recreates, or with full redeploy.
- **A secret** is a masked field that starts empty and is never filled from the manager. The page says whether one is stored, generated or set by the version, and it can be replaced or reset.
- **A key a control decides** shows its value and names the control, with no field. A value stored for it can be reset.
- **A key the version does not declare** shows its stored value and offers only a reset.
- **An engine setting** is named by its label with the key beside it, shows its help, and takes a number field with its unit and bounds or a list of its choices. Its default is beside it with where it comes from: set on this host, the version's own, or the manager's own. A search finds it by label and help as well as key. A screen reader hears the field as its label and key, then the line under it with the unit and bounds, which is also read out when a refusal replaces it, then the default a reset goes back to.

After the two web2 admin keys the card offers **Test connection**. It asks the manager to try the saved values the next deploy would give the uploader, and shows one sentence for the outcome. The stored token never leaves the manager for it.

A value the manager would refuse is named under its field, by the same shared rules, and keeps **Save** off. A pair of engine settings the engine would refuse is named once above Save, in the manager's words, and keeps Save off until the pair is valid. Stored engine settings the next deploy would refuse are named there too, saying that Apply is refused and any other deploy fails until they change. They do not block a save, so a save of other keys still goes through, and so does the save that fixes them.

**Save** sends the changed keys in one request with the revision the page read. A refused save shows the manager's sentence under the button. A save refused because another one landed first says the settings changed elsewhere and reads them again, and you make the change again.

Above the list, a banner names the settings the running containers are behind on and offers **Apply**, and after Apply says what was recreated. When Apply recreates the engine, or redeploys everything, the banner says a live publisher is disconnected for a few seconds. On a stopped deployment it says what Start will use, with no Apply. Where no container has a record to compare with, the card says so, because no key can show as behind until the next deploy.

The editor is `frontend/src/deployments/settings/DeploymentSettingsEditor.tsx`, and the card only frames it. It fits 390 pixels with no sideways scroll. The mock manager answers the three routes, so `pnpm -C frontend dev:mock` shows it with no manager.

## In the new-deployment wizard

A deployment is created with its settings already set. The wizard's settings step ends with an **Advanced settings** fold, closed until opened, because most deployments keep every version value. Its line says what it holds and, once values are typed, how many the create sends or which value it cannot send.

Opened, it shows the same list, rows and fields as the deployment's page, read from `GET /versions/:id/settings-catalog` for the version, the services and the host the create will name. A node pool is asked for as one of its rungs. The list is read from the settings step on, and again whenever the version, the engine, the services or the host change.

- **Nothing is stored yet**, so there is no banner, no Apply, no revision and no Save. A changed key is marked changed rather than unsaved, and marks nothing to recreate. Undo takes a value back out.
- **A required secret** the version leaves empty says the manager generates it at the first deploy, and a typed one replaces that.
- **A key a control decides** shows no field and names the control. `HLS_FRAGMENT` shows the segment length typed above it, so the two never disagree. The wizard asks for the segment length alone and leaves the other engine settings to the deployment's page. For a deployment that runs a stream uploader, `ADMIN_API_URL` and `ADMIN_API_TOKEN` point at the step's **Web2 admin** group, so neither is set twice.
- **A value the manager would refuse** is named under its field and stops **Continue** and **Deploy**. The footer names the key and never the value. Values typed before the list for the current choices was read wait for it.
- **A key typed under an earlier choice** that the current list does not take, such as an SRS key after switching to OvenMediaEngine, is kept and marked not sent, and comes back if the earlier choice does. A new goal clears the typed values.

Deploy sends the typed keys the current list takes as `stack_settings`. The manager checks them against the same list with the rules a save uses, `settingEditProblems`, and refuses the whole create over one bad key, naming it. Accepted values are stored at the insert, plain and secret apart, so the first deploy writes them and the deployment's page lists them as its own at revision 0. A group gives every member the same values, and a member added to a group later takes those of the group's first member, as it takes that member's engine settings. The review step names the keys the create sets and never a value.

The editor is `frontend/src/deployments/settings/NewDeploymentSettingsEditor.tsx`, built from the same `SettingsList` as the page's editor, and the fold is `frontend/src/forms/wizard/steps/AdvancedSettings.tsx`.

## Routes

All routes need a signed-in session. The full reference, with the answer shapes, is in [the API reference](../../manager/README.md#a-deployments-own-settings).

| Method | Path                             | Body                                                | Answer                                                     |
| ------ | -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/profiles/:name/settings`       |                                                     | The deployment's list, with `revision`, no-store           |
| PUT    | `/profiles/:name/settings`       | `{ expectedInstanceId, expectedRevision, entries }` | `{ revision }`                                             |
| POST   | `/profiles/:name/settings/apply` | `{ expectedInstanceId }`                            | `{ recreated }`, 202 when something is recreated, else 200 |
| GET    | `/versions/:id/settings-catalog` |                                                     | The list for a deployment not created yet, no-store        |

`POST /profiles` and `POST /groups` take `stack_settings` for a new deployment. A save carries at most 512 entries. Each entry is a key and a value, or a key and null to go back to the version's value.

| Refusal                           | When                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| 400 `validation_error`            | A value breaks its rule, a control decides the key, or engine settings would be refused. |
| 409 `deployment_settings_changed` | Another save moved the revision.                                                         |
| 409 `profile_instance_changed`    | The deployment was removed and created again under the same name.                        |
| 409 `profile_busy`                | The deployment is being removed, or, for Apply, is deploying or stopping.                |
| 409 `profile_stopped`             | Apply on a stopped deployment.                                                           |

## Limits

- The stack's sample has no section rule closing "Per-rung Bee nodes", so the start gate settings that follow it are listed under that section.
- A container started without the per-container records reads unknown until the deployment's next deploy. Apply has nothing to recreate for it, so a saved value reaches it at that next deploy, such as a Stop and a Start.
- The page cannot store an empty secret, because an empty secret field means keep what is stored. A reset puts back what the version sets.
- A stored secret's default says what the version sets. The list does not say whether the manager had generated one before, which is the value a reset of such a key goes back to.
- The wizard's typed values live only while the dialog is open. Closing it forgets them.
- A member added to a group takes the settings of the group's first member, so a value changed on that member alone travels to the new one.
- The wizard checks a typed value against the list it read, and the manager checks it again against the version's current build when the create arrives. A build published in between can refuse a create the wizard let through, and the refusal names the key.
- Right after a save, the list and the deployment's row are read one after the other, so for that moment the Engine card can mark the value from before the save. A page that another person's save changed shows the old value, unmarked, until its row is read again.
- An engine setting's default is read from the host's base `.env` and the version's own fallback, not from the engine's own env file, `engines/<engine>/.env`, which the version settings page can also set. Where that file sets an engine setting, an unset one falls back to its value rather than to the default shown.
- A key that only some sections of a config file read is not flagged on its row, only one that no section reads. The Engine card still shows each reading.
