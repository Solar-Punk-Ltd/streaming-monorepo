# Web2 admin layer

This page is the design of the admin layer, written down so that everyone
working in the repository has it in one place.

## What it is

The brand console and the API behind it. Streams, branding and users, for every
brand rather than one. Anything that touches a host or a wallet it asks the
streaming-infra-manager to do, so this is where ownership is decided rather
than where money moves.

Exactly one admin layer for every brand. If it is down, streaming continues;
nobody can create a stream, top up a batch or change a logo until it is back.

Tech tags from the model: Postgres, REST.

## Components (five)

| Component                    | Role                                                                                                                                                                 | Tech          | On loss                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| Brand console                | The only surface a customer touches. Streams, stamps, cheque balances and branding, scoped to the logged-in brand.                                                   | web UI        | API unaffected, brand cannot reach it.                                                |
| Authentication and ownership | OPEN. Who may create and manage a brand's streams. Candidates: OIDC against something the brand already has, wallet signature, magic link.                           | OIDC / wallet | Anyone reaching the API can act as any brand. Blocks the second brand, not the first. |
| Admin API                    | Every state change a brand can make, in one place. The only writer, so ownership is enforced in exactly one place. Calls the manager to provision and fund a stream. | REST          | Nothing can be created, funded or changed. Running streams carry on.                  |
| Postgres                     | Brands, users, streams, batches and branding. The one row set that has to be right about which brand owns what. Small enough that a nightly dump is a real backup.   | Postgres      | Console and API stop answering. Published streams stay published (Swarm holds them).  |
| Branding                     | Logo, colours and domain, turned into the config the Viewer SPA bootstrap reads: theme, logo, stream list, serving domain.                                           | theme, domain | Player falls back to unbranded default, a visible failure for a white-label product.  |

## Connections

Inside the container:

- Brand operator logs in to the Brand console.
- Brand console calls the Admin API.
- Admin API keeps state in Postgres.
- Authentication authorises calls to the Admin API. It sits beside the API, not
  in front of the console, because the question is which brand a call may act
  for, not who may see a page.
- Admin API provisions through the Manager API (streaming-infra-manager).
- Branding writes the theme and domain the Viewer SPA bootstrap reads.

At the platform level the admin layer also:

- tops up stamps on the Bee publishers (through the manager's stamps and cheques component),
- watches cheque balances on the Bee gateways (same route),
- hands brand config to the Viewer SPA.

## What it does not do

- It never touches a wallet or a host directly. Postage, cheques, ssh and
  docker compose all live in streaming-infra-manager.
- It does not serve media. Ingest, the ABR ladder, packaging and upload live on
  the GCP stage host; publishers and gateways live on the Vultr Bee host.

## The manager it talks to

streaming-infra-manager (https://github.com/Solar-Punk-Ltd/streaming-infra-manager)
exposes a Manager API: provision, stop, and read back what a stage is running.
Inputs to provision: media profile (four-rung ABR ladder or single rendition),
port slot, publisher list, signing key, postage batch, SRT passphrase. Output: a
running media stack. Today it has no authentication and listens on loopback of
the host it deploys to. The moment the admin layer calls it from another
machine, that call has to be authenticated and attributed to a brand. This is
the same open question as the auth component above, seen from the other end.

## Open questions carried into the build

1. Ownership across brands: which brand a call may act for. The operator half
   of this is answered — the console has usernames, passwords, an admin role
   and user management, ported from streaming-infra-manager and described in
   [web2-admin-auth.md](web2-admin-auth.md) — and streams are scoped to the
   user who created them, which is the single-tenant shape of the answer.
   Choosing how a brand proves itself, OIDC against something it already has,
   a wallet signature, or a magic link, is still open and still blocks the
   second brand rather than the first.
2. Manager API authentication once admin and manager are on different hosts.
   The manager answered its own half on `main-v2`: sessions, roles and a
   cross-site check. What is undecided is how this service authenticates to it
   as a machine caller, which is the same shape of problem the uploader's
   bearer token solves in the other direction.
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
