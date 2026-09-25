# @streaming-monorepo/web2-admin-frontend

The web2-admin console: React 18 + MUI 6 + Vite, modelled on the msrs-client
screens its operators already know and on streaming-infra-manager's frontend
conventions. It talks to [`../backend`](../backend/) over `/api` and takes its
types from [`../common`](../common/).

## Screens

| Route | Screen |
|---|---|
| `#/login` | Username, password, Log in. The API's error text is shown inline. |
| `#/` | My Streams: thumbnail, title, media type chip, status chip, scheduled start, Edit / Details / Delete, Create New Stream. |
| `#/create`, `#/edit/:id` | The msrs-client form: Stream Name (n/100), Description (n/500), Tags (Enter or Add, max 10 × 20 chars), Media Type (locked once published), Upload Thumbnail (max 5MB, preview, remove), Scheduled Start Time. |
| `#/streams/:id` | Details: metadata, publish / unpublish with feed feedback (Unpublish asks first, and for a recording says the recording stays with the stream and is listed again on the next publish), a link to the viewer catalogue plus the copyable per-stream route, last publish error, and the OBS connection details with copy buttons and Rotate key. |
| `#/account` | Change password. |

The SRT URL embeds the same per-stream `key=` as the RTMP stream key, so both
fields hide that parameter until the operator reveals it; the host, port and
stream id stay readable, and Copy always copies the real value. Copying falls
back to `document.execCommand('copy')` where `navigator.clipboard` is missing
— it is only present in a secure context, and the console is deployed over
plain http — and, failing that, selects the value for a manual copy.

The router is a `HashRouter`, so the console can be served from any path
without server rewrites. Every fetch is relative (`/api/...`) and carries
`credentials: 'same-origin'`; any unexpected 401 clears the user and the route
guard sends the operator to `#/login`.

## Running it

```bash
pnpm install                                              # from the repo root
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
node web2-admin/frontend/scripts/mock-api.mjs          # listens on 127.0.0.1:9877
pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

or, from this package, `pnpm mock-api`. Log in as `admin` / `admin1234`. It
honours a few env vars:

| Var | Default | What |
|---|---|---|
| `MOCK_API_PORT` | `9877` | listen port |
| `SEED_ADMIN_USERNAME` | `admin` | the seeded user |
| `SEED_ADMIN_PASSWORD` | `admin1234` | its password (changeable through the UI) |
| `INGEST_KEY_VERIFIED` | `false` | set `true` to hide the "ingest does not verify this key yet" note |
| `VIEWER_BASE_URL` | `http://localhost:10064` | drives the "open player catalogue" link; must be a viewer built for this backend's feed |

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
mirroring the dev proxy (`/api` → `api:9877`). Build it from the repository
root:

```bash
docker build -f web2-admin/frontend/Dockerfile -t web2-admin-frontend .
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
