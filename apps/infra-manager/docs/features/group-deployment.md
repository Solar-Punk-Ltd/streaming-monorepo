# Group deployment

A group is a set of near-identical deployments created from one form, under one
name you choose, sharing one configuration. You use it to run many streamers,
viewers or custom deployments at once, for fan-out and load tests, without
creating each one by hand. This is a feature page of the manager, the web console
and API in `apps/infra-manager` that deploys the streaming stack
(`apps/hls-stream`) onto hosts.

## What it does

- **Group.** A row of `deployment_groups`: an id, a unique name, a size, a kind
  and when it was created. A group holds no settings of its own. Every setting
  lives on its members, exactly as it would for a single deployment, so editing,
  redeploying and removing one member work unchanged.
- **Member.** An ordinary deployment whose `group_id` names the group.
- **Kind.** `standard` (`STANDARD_GROUP_KIND`) for the groups on this page.
  `abr-node-pool` (`ABR_NODE_POOL_GROUP_KIND`) is a group of one Bee node per
  quality rung, created with `abr_ladder: true`, and has rules of its own
  ([abr-ladder.md](abr-ladder.md)).

### Member names

You give the group a name, such as `loadtest`. Members are named
`<group>-profile-<N>`, from `N = 1`. A name already taken, by a single deployment
or by an earlier group with the same prefix, is skipped, and `N` advances until
the group has as many free names as it asked for. The group name is unique among
groups, and follows the deployment name rule `^[a-z0-9][a-z0-9-]{0,30}$`.

### What every member shares

Everything the create form fills is applied to every member as it is:

- `kind`, `components`, `host`, `notes`,
- `feed_owner` and `feed_topic`, for a deployment that runs a client. The topic is
  optional and follows the stack's `FEED_TOPIC_RE`, `^[A-Za-z0-9._-]{1,64}$`,
- `private_key`, the stream key, and its address `public_key`, for a deployment
  that runs a stream uploader, and `stamp_id`,
- `srt_passphrase`, so every member takes the same SRT passphrase,
- `node_mode`, `rpc_endpoint_source` and `rpc_endpoint`: one chain answer for the
  whole group. A source the body leaves out is worked out once, for every member,
- `stack_version_id`, the default version when the body names none, so every
  member runs one version,
- `engine_settings`, so every member cuts the same segments. The wizard
  pre-fills a two-second segment length wherever the deployment runs SRS,
- `stack_settings`, so every member starts with the same stack settings.

No web2 admin token is shared. Each uploader linked to the manager's admin gets a
token of its own at its first deploy ([web2-admin-link.md](web2-admin-link.md)).

### What each member has of its own

Its name, and its port slot. Each member takes the lowest free slot, with the
ports that slot reserves, as it is inserted (`insertMemberWithFreeSlot` in
`manager/src/domain/DeploymentGroupRepository.ts`). A slot any of whose ports the
fetch standard blocks is never given out, as for a single deployment.

## How to use it in the console

### Creating a group

1. Open the new-deployment wizard and pick a stream, a viewer or a custom
   deployment. Group mode is offered for these goals alone (`allowsGroup` in
   `frontend/src/forms/wizard/wizardState.ts`), whose members are
   interchangeable.
2. Turn on **Deploy several at once as a group**. The **Name** field becomes
   **Group name**, and a **How many** field appears, 2 by default. Above 20
   members (`LARGE_GROUP` in `frontend/src/forms/wizard/steps/BasicsStep.tsx`) the
   step says "Large group, double check before deploying." For a stream it says
   that every member shares one stream key.
3. Fill the other steps as for one deployment.
4. Press **Deploy group (N)**. Every member is created, then deployed.

Editing a single deployment happens in its own drawer, which has no group mode.

### The deployments table

Members of one group collapse under a group row on the Deployments page. The
group row shows a caret to expand or collapse it, the group's name, how many
members it has, its readiness, how many members run, and the buttons
**Stop all**, **Start all** and **Open**. Each member keeps its own row and its
own actions. A deployment in no group is a flat row.

### A group's page

**Open** leads to the group's page, `#/groups/<id>`. It shows the group's
readiness and its members, and offers:

- **Start all** and **Stop all**, which start or stop every member one by one.
- **Edit shared settings**, which changes the notes, the SRT passphrase, and for a
  group that runs a client the streamer to follow and the feed topic, for every
  member at once. Emptying the feed topic puts every member back on its version's
  own topic. Every member is redeployed.
- **Add members**, with a count, which creates and deploys that many new members.
  A new member takes the settings its siblings run, its secrets, its engine
  settings and its stack settings included.
- **Remove group**, which asks first, then stops and removes every member one by
  one and wipes their data directories. The group row goes when its last member
  does.

## How a create runs

`POST /groups` runs in two steps:

1. **Persist.** One transaction inserts the group row and every member row. If
   any row fails, such as a name collision or a slot shortage, the whole
   transaction rolls back and the API answers an error before any deploy starts.
2. **Deploy.** With the members stored, each member is claimed and its deploy
   started on the ordinary per-deployment path. A member that cannot be claimed
   or started stays as a deployment you can start on its own. Each member's
   progress reaches the page through the event stream and its row's status.

The route answers 202 once every member's deploy has been started. It does not
wait for them to finish.

An edit of the shared settings claims every member before it writes anything. If
any member is in the middle of a deploy, stop or removal, the edit changes none of
them and answers 409 `group_busy`, naming the busy members.

## Routes

All behind the session. The full reference is the Groups section of
[the API reference](../../manager/README.md).

| Method | Path                         | Body                                                                     | Answer                                                               |
| ------ | ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| POST   | `/groups`                    | `group_name`, `size`, `kind`, the shared fields above                    | 202, `{ group, profiles }` with each member's state after its start  |
| GET    | `/groups`                    |                                                                          | `{ groups }`, every group, oldest first                              |
| PATCH  | `/groups/:id/config`         | any of `notes`, `feed_owner`, `feed_topic`, `stamp_id`, `srt_passphrase` | 202, `{ group, profiles }` after every member is redeployed          |
| POST   | `/groups/:id/members`        | `{ count }`, at least 1                                                  | 202, `{ group, profiles }` with the new members                      |
| DELETE | `/groups/:id`                | `{ expectedName }`, the group's name as the page showed it               | 204 for a group with no members left                                 |
| GET    | `/groups/:id/bee-publishers` |                                                                          | an ABR node pool's `BEE_PUBLISHERS` ([abr-ladder.md](abr-ladder.md)) |

In a `PATCH`, a field left out keeps every member's own value, and a field sent,
null included, is applied to every member.

| Refusal                              | When                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| 409 `group_exists`                   | a group of that name exists                                          |
| 404 `group_not_found`                | no group has that id, or it has no members                           |
| 409 `group_busy`                     | an edit while a member is in the middle of a deploy, stop or removal |
| 409 `group_changed`                  | a removal whose `expectedName` is not the group's name               |
| 409 `group_not_empty`                | a removal of a group that still has members                          |
| 409 `ladder_group_invalid_operation` | a `stamp_id` for an ABR node pool, or members added to one           |

## Limits

- A group cannot yet redeploy all its members in one action. Members are
  redeployed one by one, or through an edit of the shared settings.
- A group's members all run on one host. A group cannot yet spread its members
  across hosts.
- A member cannot yet override a shared setting. Change it on the member itself,
  where it stops matching its siblings.
- Every member of a group that runs a stream uploader signs with the same stream
  key, so they all publish under one owner. That suits fan-out tests and rarely a
  real stage. The manager does not yet generate a key per member.
- The size has no upper bound. The wizard warns above 20.
- An ABR node pool takes no `stamp_id` at create or in an edit, because one batch
  would then pay for every rung, and takes no added members, because a new member
  would carry no rung name ([abr-ladder.md](abr-ladder.md)).
