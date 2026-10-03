# Web2 admin layer

This page is the design of the admin layer, written down so that everyone
working in the repository has it in one place.

## What it is

The brand console and the API behind it. Streams, branding and users, for every
brand rather than one. Anything that touches a host or a wallet is the
streaming-infra-manager's, and the manager tells the admin what it runs: since
the [stages](stages.md) work, every stage the manager deploys pushes its record
into the admin. So this is where ownership is decided rather than where money
moves.

Exactly one admin layer for every brand. If it is down, streaming continues;
nobody can create a stream, top up a batch or change a logo until it is back.

Tech tags from the model: Postgres, REST.

## Components (five)

| Component                    | Role                                                                                                                                                                                                                                                                                                                                                                          | Tech          | On loss                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| Brand console                | The only surface a customer touches. Streams and the stage each is on, the stages the manager pushed with their readiness, stamps and cheque balances, the catalogue batch, and branding.                                                                                                                                                                                     | web UI        | API unaffected, brand cannot reach it.                                                |
| Authentication and ownership | OPEN. Who may create and manage a brand's streams. Candidates: OIDC against something the brand already has, wallet signature, magic link.                                                                                                                                                                                                                                    | OIDC / wallet | Anyone reaching the API can act as any brand. Blocks the second brand, not the first. |
| Admin API                    | Every state change a brand can make, in one place. The only writer, so ownership is enforced in exactly one place. Takes the manager's stage and catalogue stamp records on the registrar token, and each stage's uploader on a token of its own, answered only about that stage's streams. Writes the catalogue through the catalogue node's batch. Never calls the manager. | REST          | Nothing can be created or changed. Running streams carry on.                          |
| Postgres                     | Users, streams and their stages, the stage and catalogue stamp records the manager pushed, every catalogue write with its exact bytes, the audit log, and later brands and branding. The one row set that has to be right about which brand owns what. Small enough that a nightly dump is a real backup.                                                                     | Postgres      | Console and API stop answering. Published streams stay published (Swarm holds them).  |
| Branding                     | Logo, colours and domain, turned into the config the Viewer SPA bootstrap reads: theme, logo, stream list, serving domain.                                                                                                                                                                                                                                                    | theme, domain | Player falls back to unbranded default, a visible failure for a white-label product.  |

## Connections

Inside the container:

- Brand operator logs in to the Brand console.
- Brand console calls the Admin API.
- Admin API keeps state in Postgres.
- Authentication authorises calls to the Admin API. It sits beside the API, not
  in front of the console, because the question is which brand a call may act
  for, not who may see a page.
- The manager (streaming-infra-manager) pushes each stage's record and the
  brand's catalogue stamp record into the Admin API over its admin link. The
  Admin API keeps what it was told and never calls the manager.
- Each stage's stream uploader asks the Admin API which stream an encoder
  publishes to and reports its state, on a token of its own.
- Branding writes the theme and domain the Viewer SPA bootstrap reads.

At the platform level the admin layer also:

- writes the brand's catalogue, signed by the brand key, through the dedicated
  catalogue node and the immutable batch the manager designates,
- shows each rung's stamp and chequebook as the manager last pushed them,
  where topping up stays in the manager's console,
- hands brand config to the Viewer SPA.

## What it does not do

- It never touches a wallet or a host directly. Postage, cheques, ssh and
  docker compose all live in streaming-infra-manager.
- It does not call the manager. It does not provision, stop or fund a stage,
  buy or top up a batch, or choose the catalogue's batch: the manager pushes
  what it runs, and the admin reads it.
- It carries no stage in its env file: no ingest address, port or passphrase,
  Bee address or batch id. It learns them from the manager's pushes, and
  refuses to publish, saying why, until the manager has designated a
  catalogue batch.
- It holds no stage's signing key. Each stage signs its feeds with a key of
  its own, and the admin knows only its address; the brand key signs the
  catalogue alone and never leaves the admin.
- It does not serve media. Ingest, the ABR ladder, packaging and upload live on
  a stage host. Publishers and gateways live on a Bee host.

## The manager that talks to it

The manager, [`apps/infra-manager`](../../apps/infra-manager/README.md),
provisions, stops and funds the stages, behind its own sessions. The admin
layer does not call it. The manager holds the admin's address and its
`INTERNAL_API_TOKEN`, the registrar token, in its admin link, and pushes with
them: every stage's record (its ingest details, the owner it signs as, its
rungs' stamps and chequebooks, its readiness, and the sha256 of its uploader's
own token) and the catalogue stamp record. [stages.md](stages.md) is the design
and the behaviour as built.

## Open questions carried into the build

1. Ownership across brands: which brand a call may act for. The operator half
   of this is answered — the console has usernames, passwords, an admin role
   and user management, ported from streaming-infra-manager and described in
   [web2-admin-auth.md](web2-admin-auth.md). A stream belongs to the
   installation: every signed-in operator can act on every stream,
   `streams.user_id` records who drafted it, and the audit log
   (migration 007) records who acted on it since. That is the single-tenant
   shape of the answer. Separating one brand's streams from another's, and
   choosing how a brand proves itself (OIDC against something it already has,
   a wallet signature, or a magic link), are still open and still block the
   second brand rather than the first.
2. Manager API authentication once admin and manager are on different hosts.
   The manager answered its own half on `main-v2`: sessions, roles and a
   cross-site check. What is undecided is how this service authenticates to it
   as a machine caller, which is the same shape of problem the uploader's
   bearer token solves in the other direction. Decided on 2026-09-28 and
   described in [stages.md](stages.md): the admin does not call the manager.
   The manager pushes what the admin needs over the admin link it already
   holds.
3. Chat: Swarm feeds/GSOC versus a websocket in the web2 layer. Drawn in the
   SPA, not decided. Only matters here if the websocket answer wins.

## Stack (decided 2026-09-11)

Same as streaming-infra-manager, so the two codebases feel like one team's:

- TypeScript, ESM, exact-pinned dependencies, pnpm workspace.
- `apps/web2-admin/backend`: Express 5, `pg`, yup validation, SQL migrations in
  the repo run on startup, Node test runner through tsx (unit and integration).
- `apps/web2-admin/frontend`: React 18, MUI, Vite. The console is modelled on
  msrs-client (https://github.com/Solar-Punk-Ltd/msrs-client), the deprecated
  admin UI this console replaces.
- Package scope `@streaming-monorepo/`.
