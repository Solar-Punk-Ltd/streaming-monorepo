# The console

This page describes the manager's web console, `apps/infra-manager/frontend`: its pages, the
readiness checklist on a deployment's page, the new-deployment wizard, and how to run the console
against an offline mock while you work on it. It is a concepts page. Each feature the console
offers has its own page in [features/](features/).

The console is a React app served by the `web` container's nginx, which forwards the API paths to
the manager. It needs a signed-in session for everything but the sign-in page.

## Pages

The sidebar holds every page. Routes are hash routes (`frontend/src/app/router.ts`), so nginx and
the Vite dev server serve one page and never see them. An unknown hash shows the Overview.

| Page             | Hash                   | What it shows                                                                                                                                                                                                                                   |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview         | `#/`                   | Host health (CPU, memory and disk, the manager's deployments against everything else), deployment counts, a "Needs attention" list where each item carries the button that fixes it, the streams with their publish URL, and recent activity    |
| Deployments      | `#/deployments`        | Every deployment, with filter chips, a search box, groups as collapsible blocks, and per row a status, a readiness pill, quick links, a Start or Stop button and a menu. Clicking a row opens its page                                          |
| A deployment     | `#/deployments/<name>` | See [A deployment's page](#a-deployments-page)                                                                                                                                                                                                  |
| A group          | `#/groups/<id>`        | Its members, Start all, Stop all, Add members, Edit shared settings and Remove group. For an ABR node pool, one row per rung and the pool string. See [Group deployment](features/group-deployment.md) and [ABR ladder](features/abr-ladder.md) |
| Stages           | `#/stages`             | Every stage record the manager pushes into the admin, with its last push. See [Stages](features/stages.md)                                                                                                                                      |
| Transfers        | `#/transfers`          | Every chequebook transfer, with a page per transfer and its recovery actions. See [Chequebook](features/chequebook.md)                                                                                                                          |
| Host             | `#/host`               | CPU, memory, disk, network and disk I/O of the host, and a table of every deployment's containers                                                                                                                                               |
| Versions         | `#/versions`           | The stack versions, their builds and the deploy attempts that hold a project. **Settings** on a card opens `#/versions/<id>/settings`. See [Stack versions](features/stack-versions.md)                                                         |
| Access           | `#/access`             | The users, their sessions, and the password change. See [Sign-in and public access](features/auth-and-public-access.md)                                                                                                                         |
| Manager settings | `#/manager-settings`   | The admin link for new deployments and the catalogue node. See [The admin link](features/web2-admin-link.md) and [Stages](features/stages.md#the-catalogue-node)                                                                                |

The sidebar shows the manager's instance name and the build it runs, from `GET /config` and
`GET /version`. The theme follows the system and can be switched to light or dark in the sidebar.

## A deployment's page

The header carries the name, the kind in plain words, the status and the actions. The cards below
appear when they apply to the deployment:

- **Last error**, when the last deploy, stop or removal failed.
- **Held attempt**, when a deploy attempt still holds the deployment's project.
- **Readiness**, the checklist below.
- **Ingest health**, how the SRT and RTMP ingest held up over the last minute. See
  [SRT ingest health](features/srt-ingest-health.md).
- **Publish**, the SRT publish URL, and for SRS the RTMP server and stream key for OBS.
- **Engine**, the media server's settings, restart, logs and config file. See
  [Engine control](features/engine-control.md) and [Engine config](features/engine-config.md).
- **Stack settings**, every key of the deployment's stack version. See
  [Deployment settings](features/deployment-settings.md).
- **Watch**, the player's URL and the stream it follows.
- **Storage**, the Bee node's wallet, chequebook and postage batches. See
  [Postage stamps](features/postage-stamps.md) and [Chequebook](features/chequebook.md).
- **Publishes to**, for an ABR uploader, the pool's rungs.
- **Containers**, one row per container with its ports and its CPU and memory.
- **Configuration**, the fields fixed at creation and the ones an edit changes.
- **Web2 admin stage**, the deployment's stage record and its last push.
- **At a glance**, **Next steps** and **Notes** in the side column.
- **Remove**.

Edit opens a drawer on the right with only the fields an edit may change. Type, components, host
and name are fixed at creation. Saving redeploys.

## The readiness checklist

A running container is not evidence that a stream is received, uploaded or playable. So the
deployment page orders what has to be true, step by step, and the first step that is not done
gives the page its headline and its primary action. The steps are built by `buildChecklist` in
`common/src/readinessChecklist.ts`, and each is done, a warning, an error, busy or off.

| Step                 | Applies to                                  | Done when                                                            |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Containers running   | every deployment                            | The deployment is `RUNNING`                                          |
| Bee API observation  | a deployment with its own Bee node          | The node answers its `/health` and `/readiness`                      |
| Bee node funded      | a deployment with its own light Bee node    | The wallet holds xDAI and BZZ, and the chequebook is above the floor |
| Postage stamp set    | a deployment with its own light Bee node    | A usable batch is set                                                |
| Node pool configured | an ABR uploader                             | The pool string names every rung                                     |
| Uploader running     | a stream or an ABR uploader                 | The uploader runs and reports itself healthy                         |
| Following a stream   | a viewer, or any deployment with a `client` | A feed owner is set                                                  |

An ultra-light Bee node has no chequebook and buys no postage, so it skips the funding and stamp
steps.

The page reads the Bee node every ten seconds (`NODE_REFRESH_INTERVAL_MS` in
`frontend/src/uploaders/beeReadiness.ts`). An observation counts for 30 seconds from the moment
the browser received it (`OBSERVATION_MAX_AGE_MS`), measured on the browser's own monotonic clock
rather than compared with the server's time. A refresh clears the balances and batches the
checklist uses at once, and keeps the previous node observation on screen, marked stale, until the
new one arrives. Unknown, starting, unhealthy, unreachable and stale are shown as different states.
The checklist shows no time estimate, because Bee's probes give none.

While a deploy runs, the page says whether it is starting or restarting the deployment. The manager
records that intent in the same database update that marks the deployment `DEPLOYING`, so it
survives a page reload.

## The new-deployment wizard

**+ New deployment** opens a four-step dialog: What to set up, Basics, Settings and Review.

1. **What to set up.** Stream to Swarm (`srs`, `stream-uploader`, `bee-uploader`), Watch a stream
   (`client`, `bee-gateway`), ABR node pool (four `bee-uploader` nodes), ABR uploader (`srs`,
   `stream-uploader`) or Custom.
2. **Basics.** The name, the host (this machine or another host over SSH), whether to create
   several at once as a group, and notes.
3. **Settings.** Only the fields the choice needs: the media engine, the SRT passphrase, the stream
   key, the postage batch, the Bee node, the stream to follow, the node pool, the admin link,
   and under Advanced settings every key of the stack version.
4. **Review.** Everything chosen, and one sentence on what happens next.

Continue stays disabled while a step has an error, and the error is written beside the field. The
close button and Escape close the dialog, and a click outside it does not, because closing forgets
the draft. A stream's page offers "Create a viewer for this stream", and a pool's page "Create an
ABR uploader using this pool", which open the wizard with the choice made.

## Working on the console

From `apps/infra-manager/frontend`:

```sh
pnpm dev:mock   # an offline mock manager on 127.0.0.1:9876
pnpm dev        # the console on Vite, proxying to http://localhost:9876
```

The mock manager, `frontend/dev/mock-manager.mjs`, answers every route the console calls with the
shapes in `common` and `frontend/src/types`, from seed data made at start. It needs no database, no
Docker and no Bee node, and every key, address and batch id in it is random. Sign in as `dev` with
the password `dev-password-1234`. `PORT` moves the mock, and `VITE_MANAGER_URL` points Vite at
another manager, such as one started with `pnpm dev` in `manager/`.

The console's user-facing text follows the repository's writing rules: no em-dashes and no
semicolons, plain words first and service names second. A private key is never shown in full.

The unit suites run with `pnpm test` and the browser suites with `pnpm test:browser`.
[CI and local checks](ci.md) says what each needs.
