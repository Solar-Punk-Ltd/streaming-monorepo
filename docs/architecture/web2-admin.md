# The admin

This page explains what the admin (`apps/web2-admin`) is for, how it fits with the manager and the
stack, and why it is shaped the way it is. It describes concepts, not routes or settings: those are
in [the backend's README](../../apps/web2-admin/backend/README.md).

## What it is for

The admin is the brand console and the API behind it. A brand is a customer that streams under its
own name. Its operators sign in to the admin to draft streams, publish them to the stream list that
viewers read, called the catalogue, get the OBS details for each broadcast, watch the stages their
streams run on, and fund the nodes behind those stages.

The admin is the one place a brand changes anything. Anything that touches a host or a node's
wallet belongs to the manager. If the admin is down, broadcasts that are running carry on, and
published streams stay published, because Swarm holds them. Nobody can create, publish or change a
stream, or fund a node, until it is back.

## The parts

| Part         | Role                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The console  | The only surface an operator touches: streams and the stage each is on, the stages the manager pushed with their readiness, stamps and chequebooks, the catalogue's batch, funding, and the users who may sign in. It has two looks, and a host's default look is a setting. |
| The API      | Every change an operator can make, in one place. It is the only writer of the catalogue, so who may do what is enforced in one place. It takes the manager's pushes and each stage uploader's reports on bearer tokens, and calls the manager's funding API.                 |
| Postgres     | Users and sessions, streams and their stages, the records the manager pushed, every catalogue write with its exact bytes, the funding journals and the audit log.                                                                                                            |
| Sign-in      | Usernames, passwords, an admin role and server-side sessions ([web2-admin-auth.md](web2-admin-auth.md)).                                                                                                                                                                     |
| The contract | `@streaming-monorepo/web2-admin-common`, the types the API answers and the console reads.                                                                                                                                                                                    |

## How it relates to the manager and the stack

```
  console ──────────────────────────▶ admin API ──── writes ───▶ the catalogue on Swarm
                                       ▲     │
     stage and catalogue stamp pushes  │     │  funding API calls
                                       │     ▼
                                      manager

  stage's uploader ── lookup and state reports, on the stage's own token ──▶ admin API
```

- **The manager** (`apps/infra-manager`) deploys and runs the stages, a stage being one deployment
  of the stack that takes broadcasts in, and the Swarm nodes they upload through. Over its admin
  link, it pushes the admin a record of every stage it runs (its ingest address, the address it
  signs as, its rungs' stamps and chequebooks, its readiness, and the sha256 of its uploader's own
  token) and the record of the catalogue stamp, the postage batch and node the catalogue is written
  with. The admin keeps what it was told. [stages.md](stages.md) describes those records.
- **The admin calls the manager** for one thing, its funding API, on a bearer token of its own:
  to read the node wallets, to relay transfers the brand wallet signed, and to ask a node to top up
  or dilute a batch or move its chequebook, which the node pays for itself.
  [funding.md](funding.md) describes it.
- **The stack's uploader** runs on each stage. When an encoder connects, it asks the admin which
  stream that is, checks the stream's key, and uploads the broadcast. It reports to the admin when
  the broadcast goes live and when it ends, and each rung of an adaptive bitrate ladder reports its
  own feed.

## Who writes what on Swarm

A viewer finds streams in the catalogue, a Swarm feed holding one JSON list of entries, and plays a
stream from its own manifest feeds. Two writers on one feed fork it, because each would take the
same next index. So the writing is split:

- **The admin is the only writer of the catalogue.** It signs it with the brand key, a key that
  never leaves the admin. It takes the next index from its own record of every write, never from a
  Bee node, because a node's view of a feed can lag a write it just made.
- **The uploader is the only writer of each stream's feeds.** Each stage signs with a key of its own,
  and a stream takes its stage's address as its owner, so the owner on the catalogue entry is the
  owner of the feeds the viewer plays. The admin holds no stage's key.
- **The uploader reports, the admin rewrites the entry.** A state report moves the stream to live
  or recorded, and the admin writes that onto the stream's catalogue entry. With an adaptive bitrate
  ladder, the stream's topic is the topic of the master playlist, each rung's feed topic is derived
  from it and the rung's name, and the admin merges the rungs' reports onto the entry.

A stream is a row in Postgres first and a catalogue entry second. An operator drafts it, and
publishing writes the entry. A write that fails leaves the row as it was, with the reason, to try
again.

## What it does not do

- It never holds a node's key and never touches a host. Postage, cheques, ssh and Docker all belong
  to the manager. The one wallet the admin holds is the brand wallet, and it signs with that alone.
- It does not provision or stop a stage, buy a batch, or choose the catalogue's batch. The manager
  pushes what it runs, and the admin reads it.
- It carries no stage in its settings: no ingest address, port or passphrase, Bee address or batch
  id. It learns them from the manager's pushes, and refuses to publish, saying why, until the
  manager has designated a catalogue batch.
- It does not serve media. Ingest, the bitrate ladder, packaging and upload live on a stage host.
- It serves one installation. Every signed-in operator can act on every stream, and the audit log
  records who did.
- It is not deployed by the manager. Its deploy script takes the manager's flags and is run by hand
  ([the deploy guide](../../apps/web2-admin/deploy/README.md#deploying)).

## The stack it is built on

The admin follows the manager's conventions where a choice is arbitrary, so the two read as one
codebase: TypeScript and ESM with exact-pinned dependencies in the repository's pnpm workspace,
Express 5 with `pg` and yup, SQL migrations run at startup, `node:test` through tsx, and a React,
MUI and Vite console. Sign-in shares its code with the manager through `packages/web-auth`.
