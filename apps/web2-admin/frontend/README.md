# @streaming-monorepo/web2-admin-frontend

The web2-admin console: React 18 + MUI 6 + Vite, modelled on the msrs-client
screens its operators already know and on streaming-infra-manager's frontend
conventions. It talks to [`../backend`](../backend/) over `/api` and takes its
types from [`../common`](../common/).

## Screens

| Route                    | Screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/login`                | Username, password, Log in. The API's error text is shown inline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `#/`                     | Streams, every one of the installation's, whoever drafted it: thumbnail, title with the description below it in two lines at most (the whole of it on hover), stage (retired ones marked, No stage for none), media type chip, status chip, scheduled start, Edit / Details / Delete, Create New Stream. A Stage filter above the table narrows the list to one stage, or to the streams with none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `#/create`, `#/edit/:id` | The msrs-client form: Stream Name (n/100), Description (n/500), Tags (Enter or Add, max 10 × 20 chars), Media Type (locked once published), Upload Thumbnail (max 5MB, preview, remove), Scheduled Start Time, and Stage: the stages that are not retired and are supported, the only one preselected on a new stream, locked once published or while the stream holds a recording. While the stage can still be changed, one whose readiness is not ready shows the manager's verdict ("has a warning", "is blocked", "readiness is unknown"), its reasons and when the manager last confirmed it, as a warning that does not block the save. A draft from before stages that holds a recording is warned that its first stage is final and must be the one the recording was made on, and the save asks once more.                                                                                                                                                                                                                                                                                                                                                                      |
| `#/streams/:id`          | Details: metadata and the stage (Publish stays disabled on a draft with no stage, with a hint and a link to the form), publish / unpublish with feed feedback (Republish stays disabled, saying the catalogue already has the latest edit, while the stream holds no edit its entry lacks and its last attempt did not fail; Unpublish asks first, and for a recording says the recording stays with the stream and is listed again on the next publish), a link to the viewer catalogue plus the copyable per-stream route, last publish error, and the OBS connection details: what goes in OBS's Server box and Stream Key box, for SRT, and for RTMP as well where the stage opens it, with copy buttons and Rotate key. They are the stage's: without one the panel says to pick one.                                                                                                                                                                                                                                                                                                                                                                                                |
| `#/stages`               | Stages, as the manager last pushed them: name and kind, the manager's readiness chip with its reasons, status and the uploader's state, the ingest host and SRT port (and whether there is a passphrase, never the passphrase), per rung the stamp state, the time left as of the API's answer (aged from the manager's reading) and fill and the chequebook's health, which token the stage's uploader presents (its own; any other, `shared`, in the error colour, saying it is refused until the uploader's admin token is rotated in the manager and the stage redeployed; or none pushed), and when the manager last confirmed the stage. Retired stages and OvenMediaEngine ones ("Not supported yet") are marked. A card above the table shows the catalogue stamp, or says the manager has not designated one. A batch under 48 hours left is shown in the warning colour and one expired or gone in the error colour, as is one whose last reading's time to live has run out since, whose state chip and numbers read "Expired by the clock" whatever state the manager last read. With no stages the page says they appear once the manager's admin link points at this admin. |
| `#/account`              | Change password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The OBS panel is built from the stream's stage, as the manager pushed it. It
offers SRT, and RTMP as well only on a stage whose record says `rtmpPublic`.
The manager says it on no stage, because RTMP is closed to the outside on
every stage for now, so the panel offers SRT alone. Where a record does say
it, the panel warns beside RTMP that RTMP is not encrypted: the stream key
crosses the network as readable text, anyone who reads it there can publish to
the stream with it, and since the stage lets a new RTMP publisher with the key
take over a live stream, they can replace a live broadcast too, whichever
protocol it came in over. It says that SRT with the stage's passphrase keeps
the picture private but not the key, because SRT sends the key before
encryption starts and a key read off either protocol publishes over RTMP while
RTMP is open. On a stage with no SRT passphrase it says so instead of
recommending one. The SRT Server line carries the same per-stream `key=` as the RTMP
stream key, and the SRT passphrase wherever OBS can read it there, so the console hides
those values, and the SRT Password field when there is one, until the operator
reveals them. The host, port and stream id stay readable, and Copy always
copies the real value. `navigator.clipboard` exists only in a secure context,
so on a console served over plain http Copy falls back to
`document.execCommand('copy')` and, failing that, selects the value for a
manual copy.

The router is a `HashRouter`, so the console can be served from any path
without server rewrites. Every fetch is relative (`/api/...`) and carries
`credentials: 'same-origin'`; any unexpected 401 clears the user and the route
guard sends the operator to `#/login`.

## Running it

```bash
pnpm install                                              # anywhere in the repository, once for the whole workspace
pnpm --filter @streaming-monorepo/web2-admin-frontend dev  # http://localhost:5081
```

The dev server proxies `/api` to `VITE_WEB2_ADMIN_URL`, defaulting to
`http://localhost:9877` — the backend's port. To point it elsewhere:

```bash
VITE_WEB2_ADMIN_URL=http://127.0.0.1:9877 \
  pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

### Without the backend: the mock API

`scripts/mock-api.mjs` is a dependency-free stand-in for the backend that keeps
everything in memory. It is for UI work only — it does not validate like the
real yup schemas and it is not the contract. Use it when you want to click
through the console without a Postgres and a Bee node:

```bash
node frontend/scripts/mock-api.mjs                     # listens on 127.0.0.1:9877
pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

or, from this package, `pnpm mock-api`. Log in as `admin` / `admin1234`. It
honours a few env vars:

| Var                   | Default                  | What                                                                                                                                         |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_API_PORT`       | `9877`                   | listen port                                                                                                                                  |
| `SEED_ADMIN_USERNAME` | `admin`                  | the seeded user                                                                                                                              |
| `SEED_ADMIN_PASSWORD` | `admin1234`              | its password (changeable through the UI)                                                                                                     |
| `MOCK_RTMP_PUBLIC`    | `false`                  | set `true` to see the OBS panel of a stage whose record opens RTMP, which no stage the manager pushes does today                             |
| `MOCK_NO_STAGES`      | unset                    | set `true` to start with no stages: the Stages page's empty state, and a stage picker with nothing to pick                                   |
| `VIEWER_BASE_URL`     | `http://localhost:10074` | drives the "open player catalogue" link. It must be a viewer built for this backend's feed                                                   |
| `MOCK_NO_USERS`       | unset                    | set `true` to start with no users, the only way to see the console's "no users yet" screen                                                   |
| `MOCK_RECORDING`      | unset                    | set `true` to start with one finished recording on the feed, the only way to see a recording's details and to unpublish and publish it again |

## Checks

```bash
pnpm --filter @streaming-monorepo/web2-admin-frontend test       # vitest + jsdom
pnpm --filter @streaming-monorepo/web2-admin-frontend typecheck  # tsc --noEmit
pnpm --filter @streaming-monorepo/web2-admin-frontend build      # builds common, then vite build
```

`build` builds `../common` first: its package `exports` only map to the TS
source under the `development` condition, which Vite applies while serving and
testing but not in a production build.

## Production

`Dockerfile` builds the SPA and serves it from nginx, with `nginx.conf`
mirroring the dev proxy (`/api` → `api:9877`). Build it from
`apps/web2-admin`, in a copy of that folder made outside the checkout by
`tools/app-workspace/in-copy.mjs`, which carries the admin's own lockfile, cut
out of the repository's root one when the root keeps it:

```bash
node ../../tools/app-workspace/in-copy.mjs --app apps/web2-admin -- docker build -f frontend/Dockerfile -t web2-admin-frontend .
```

## Layout

```
src/
  main.tsx      dark MUI theme + CssBaseline
  App.tsx       routes
  auth.tsx      session context; drops the user on any 401
  api.ts        one function per endpoint
  http.ts       getJson / sendJson / sendBytes / extractApiError
  errors.ts     snake_case API codes → sentences
  format.ts     dates, datetime-local conversion, hex elision
  components/   app shell, route guard, snackbar, chips, copy button, form fields, OBS panel
  pages/        one file per screen
  test/         vitest suites and their helpers
```
