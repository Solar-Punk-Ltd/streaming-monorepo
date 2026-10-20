# @streaming-monorepo/web2-admin-frontend

The console of the admin: the web app a brand's operators sign in to. This page says how to run
and develop it, what each of its pages does, and how its looks are built. It is a React 19, MUI 9
and Vite single-page app. It talks to [the backend](../backend/README.md) over `/api` and takes its
types from [`../common`](../common/).

## Run it

```bash
pnpm install                                               # anywhere in the repository, once for the whole workspace
pnpm --filter @streaming-monorepo/web2-admin-frontend dev  # http://localhost:5081
```

The dev server proxies `/api` to `VITE_WEB2_ADMIN_URL`, which defaults to `http://localhost:9877`,
the backend's port. To point it elsewhere:

```bash
VITE_WEB2_ADMIN_URL=http://127.0.0.1:9877 \
  pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

### Without the backend: the mock API

`scripts/mock-api.mjs` stands in for the backend with no dependencies, keeping everything in
memory. It is for working on the console only: it does not validate the way the backend does, and
it is not the contract. Use it to click through the console without Postgres or a Bee node:

```bash
node frontend/scripts/mock-api.mjs                         # from apps/web2-admin, listens on 127.0.0.1:9877
pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

From this package, `pnpm mock-api` does the same. Sign in as `admin` with the password
`admin1234`. Nothing deployed the mock, so its build line reads `Version development build`.

| Variable              | Default                  | What it does                                                                                                                                                   |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_API_PORT`       | `9877`                   | the port it listens on                                                                                                                                         |
| `SEED_ADMIN_USERNAME` | `admin`                  | the user it starts with                                                                                                                                        |
| `SEED_ADMIN_PASSWORD` | `admin1234`              | that user's password, which the console can change                                                                                                             |
| `MOCK_NO_USERS`       | unset                    | `true` starts with no users, the only way to see the console's "no users yet" screen                                                                           |
| `MOCK_NO_STAGES`      | unset                    | `true` starts with no stages: the Stages page's empty state, and a stage picker with nothing to pick                                                           |
| `MOCK_RECORDING`      | unset                    | `true` starts with one finished recording on the catalogue, to see a recording's details and to unpublish and publish it again                                 |
| `MOCK_FUNDING`        | unset                    | `off` shows the Funding page's "not set up" state. `refuse` and `lost` play the two failures, as [below](#the-mock-funding)                                    |
| `MOCK_DEFAULT_THEME`  | `default`                | the host's default look `GET /api/config` answers. The mock checks no name. `default` is a look the console does not carry, so the console falls back to Swarm |
| `VIEWER_BASE_URL`     | `http://localhost:10074` | the "open player catalogue" link. It must be a viewer built for this catalogue                                                                                 |

#### The mock funding

Unless `MOCK_FUNDING` is `off`, the mock holds a brand wallet and the mock stage's nodes, one in
each address state. It takes the seeded password and locks it out for a minute after four wrong
ones. It answers every transfer, stamp operation and chequebook move with `settled` and `watched`
as the API works them out, names an open one in `openBulkId`, `openStampBulkId` or
`openChequebookBulkId` until it settles, and refuses another of the same kind until then.

- **Balance.** A send is confirmed in a block six seconds after it is made.
- **Stamps.** The view answers today's price of postage. The nodes hold one batch of each kind the
  tab shows: the catalogue's, an immutable one whose 30 days cost more than its node holds, one no
  dilution leaves 7 days, an expired one, and one its node could not be read about. A stamp bulk is
  checked as the API checks it, then sends its operations two seconds apart and confirms each six
  seconds after it is sent, when the batch gains its days or its depth and its node pays.
- **Chequebooks.** Against a target of 2 xBZZ, the nodes hold a chequebook under it (whose node
  cannot pay a deposit to a target over 5.4 xBZZ), one over it, one at it (whose node holds no xDAI
  for gas), one whose node could not be read, a light gateway's shown read-only, and an ultra-light
  gateway with none. A chequebook bulk is checked as the API checks it, sends its moves two seconds
  apart, reports each `mined` two seconds after it is sent and confirms it six seconds after that.

With `MOCK_FUNDING=refuse`, every transfer fails at the relay with no block and is then mined
anyway six seconds later, and every stamp and chequebook operation is refused. With
`MOCK_FUNDING=lost`, every operation is first not known, as when the manager loses the chain's
answer, then sent three seconds later and confirmed.

## Pages

The router is a `HashRouter`, so every route starts with `#/`.

### Sign in, `#/login`

Username, password and Log in. The API's error text shows inline. On a database with no users the
page says so and shows the command that makes the first one.

### Streams, `#/`

Every stream of the installation, whoever drafted it: thumbnail, title with up to two lines of
description (all of it on hover), stage (retired ones marked, No stage for none), media type,
status, scheduled start, and Edit, Details and Delete. A Stage filter narrows the list to one stage
or to the streams with none. A banner says when the catalogue cannot be written, when a move of the
catalogue to another batch is waiting, and when its batch is under 48 hours from expiry or 90% full.

### Create and edit, `#/create` and `#/edit/:id`

- Stream Name (up to 100 characters), Description (up to 500), Tags (Enter or Add, at most 10 of up
  to 20 characters), and a thumbnail of up to 5 MB with a preview.
- Scheduled Start Time takes any day and time, past ones included. It is only shown to viewers and
  starts nothing. It is locked once the stream has gone live.
- Stage lists the stages that are not retired and are supported, and preselects the only one on a
  new stream. It is locked once the stream is published, or while it holds a recording. A stage
  whose readiness is not ready shows the manager's verdict, its reasons and when the manager last
  confirmed it, as a warning that does not block the save.
- A recorded draft with no stage is warned that its first stage is final and must be the one the
  recording was made on, and the save asks once more.
- There is no media type choice: every stream is saved as a video stream. An audio-only stream
  keeps its type once it is published or has gone live, where the API locks it.

### Stream details, `#/streams/:id`

- The stream's details and its stage. Publish stays disabled on a draft with no stage, with a link
  to the form.
- Publish and Unpublish, with what the catalogue write did. Republish stays disabled while the
  catalogue already carries the latest edit and the last attempt did not fail. Unpublish asks
  first, and for a recording says the recording stays with the stream and is listed again on the
  next publish. An "Edited since it was published" notice shows while the catalogue entry lacks an
  edit.
- A link to the viewer's catalogue, the copyable route of this stream in the viewer, and the last
  publish error.
- The OBS panel, described below.

### Stages, `#/stages`

Every stage as the manager last pushed it: name and kind, the manager's readiness with its reasons,
status and the uploader's state, the ingest host and SRT port, and whether there is an SRT
passphrase (never the passphrase). Per rung, the stamp's state, its time left (aged from the
manager's reading to the API's answer) and fill, and the chequebook's health. Which token the
stage's uploader presents: its own, or `shared` in the error colour, with the fix (rotate the
uploader's admin token in the manager and redeploy the stage). Retired stages and OvenMediaEngine
ones ("Not supported yet") are marked.

A card above the table shows the catalogue stamp, or says the manager has not designated one. A
batch under 48 hours left shows in the warning colour. One that is expired or gone shows in the
error colour, as does one whose last reading's time to live has run out since, which reads "Expired
by the clock". When the catalogue's history has to move to the designated batch, the catalogue move
card offers the move and follows it, or says the move is not enabled on this installation
(`CATALOGUE_MOVE_ENABLED` in the backend's settings). With no stages, the page says they appear once the
manager's admin link points at this admin.

### Funding, `#/funding`

Three tabs. Each keeps what is ticked and typed in it while the page stays open, and reads the
view again when it is shown. Without the manager's funding settings, the page says funding is not
set up. What the API does behind each tab is in the backend's [Funding](../backend/README.md#funding).

**Balance** sends xDAI and xBZZ from the brand wallet to the nodes' wallets.

- The brand wallet's address with Copy and a QR code, its balances, and a line saying to fund it
  from any wallet.
- Every node, the catalogue node on top and each stage's below, as a card of its name, stage and
  role, and its wallet address with whether it is confirmed, new or changed (the old address on
  hover). Beside each, its xDAI and xBZZ to three decimals (the exact amount on hover), the amount
  to send, and what it will hold after.
- Typing an amount ticks the node, and clearing both unticks it. Amounts take digits and one dot.
  Clear all empties every amount. A node two stages share is listed under both and sent to once.
- Confirm addresses asks for the password and confirms every new and changed address.
- Send stays disabled while a total is over the wallet's balance, a ticked node's address is not
  confirmed, an amount cannot be read, nothing is entered, or a send is on its way. Send shows what
  goes where and asks for the password, then reads each transfer every 3 seconds, with its
  transaction on the block explorer, for ten minutes at most before it offers Check again. Send is
  free again once the API says every transfer is `settled`, and the page keeps reading while any
  is `watched`.
- Amounts are exact both ways, as wei (18 decimals) and PLUR (16).

**Stamps** tops up or dilutes the batches the nodes upload with. Each node pays from its own
wallet, so there is no password, only a confirm dialog.

- A row per batch, the catalogue's on top and each stage's below: a tick box, the batch's short id
  with Copy and an Immutable chip, the node's card, its depth, time left and fill. A gateway has no
  batch and no row. Only a batch read whole, usable, not expired and whose node's wallet was read
  has a tick box. The others say why.
- Select all, Clear, and a tick box per group. Switching between Top up and Dilute clears the ticks.
- Top up takes days on a slider from 1 to 365, presets of 7, 30 and 90, or any whole number from 1.
  Each ticked row shows its time left after, its cost in xBZZ, and its node's xBZZ after. Dilute
  takes 1 or 2 steps, and each row shows its new depth and time left after.
- A row shows in red what its node lacks, and a dilution that would leave its batch under 7 days or
  take it past depth 40 is refused there. Fund all opens Balance with every short node ticked and
  the amount it lacks filled in.
- The dialog reads the view again and lists each batch with its days and cost, or its new depth.
  Each top-up carries the price the page quoted, and the API refuses it if postage costs more by
  then, so a top-up never costs more than the dialog said.

**Chequebooks** brings the chequebooks of the stages' nodes to a target balance. Each node pays from
its own wallet, so there is no password, only a confirm dialog.

- A row per chequebook under its stage: a tick box, the node's card, the chequebook's available
  balance, its total and its uncashed cheques, then the node's xBZZ and xDAI. The catalogue node's
  chequebook is not listed. A gateway's is shown read-only.
- The target is in xBZZ, at least 1. Each ticked row then shows its move: a deposit from the node's
  wallet when it is under the target, a withdrawal into the node's wallet when it is over, or no
  change. Fund all works as on the Stamps tab.
- The dialog lists each move with every digit, and says each move is worked out again from the
  balance read when it is sent and never moves more than listed. A busy node keeps paying its
  peers, so its balance lands near the target, not on it.
- The page follows each move through Sent, Mined and Confirmed. A move is confirmed once its block
  is final, about 3 minutes after it is mined.

### Access, `#/access`

Who can sign in. An admin adds and removes users and signs anyone out. Everyone else sees the list.
Everyone can change their own password. `#/account` redirects here.

## How the console behaves

### The OBS panel

The panel on a stream's details page tells an operator what to type into OBS's Server and Stream
Key boxes. It is built from the stream's stage, as the manager pushed it, and offers SRT only. On a
stage that also takes RTMP the API still answers the RTMP server and stream key, and the panel
leaves them out. The SRT Server line carries the stream's `key=` and, where OBS can read it there,
the SRT passphrase, so the panel hides those values, and the SRT Password field when there is one,
until the operator reveals them. Copy always copies the real value. `navigator.clipboard` exists
only in a secure context, so on a console served over plain http Copy falls back to
`document.execCommand('copy')` and, failing that, selects the value for a manual copy. Rotate key
asks first. Without a stage the panel says to pick one.

### Sessions

Every fetch is relative (`/api/...`) and carries `credentials: 'same-origin'`. Any unexpected 401
clears the user, and the route guard sends the operator to `#/login`.

An idle tab finds out too. While someone is signed in, the console asks `GET /api/auth/me` again on
window focus and when the tab becomes visible, at most once every five seconds, so a session revoked
from another browser shows "Your session ended. Log in again." the next time the operator looks at
the tab. There is no timer, because every request keeps the session's idle clock running. Other tabs
of the same browser are told at once over a `BroadcastChannel`, and a reload after a revoke shows
the same notice. On the change-password form, a 401 `unauthenticated` signs out too, and only
`invalid_credentials` means the current password was wrong.

### The build line

Beside the signed-in account, a small muted line names the build the API runs:
`Version <label> (<short commit>)`, the label alone when it already starts with the short commit,
or `Version development build` when the API carries no version. The full commit is the line's
title. It is asked once after each sign-in, from `GET /api/version`, which answers signed-in users
only. An API that cannot say shows no line, and neither does a screen narrower than a tablet.
`versionText` in `src/format.ts` is the rule.

## Themes

The console has two looks:

- **Swarm**, the Swarm brand as the event viewer wears it: near-black, the Swarm orange, Geist.
- **Web3Privacy**, web3privacy.info's own: black, the neon green, Archivo with Domine headings.

A browser wears the first of these that applies:

1. **The user's own pick in this browser.** Anyone signed in picks one under Theme in the user
   menu, which stays open so the looks can be compared. The pick is kept in this browser under
   `web2-admin-theme`, through reloads and sign-outs, so the login page wears it too. The menu has
   no item that forgets it.
2. **This host's default.** `GET /api/config` answers it as `defaultTheme`.
3. **The host's default as this browser last heard it**, while `/api/config` has not answered yet,
   so a returning visitor sees no flash of another look. It is kept under `web2-admin-theme-host`
   and refreshed on every answer. A config that cannot be read, or one naming a look this console
   does not carry, leaves it as it is.
4. **Swarm**, `DEFAULT_ADMIN_THEME` of web2-admin-common.

The host's default is stored in the admin's database and applies to every browser that opens this
host. An admin sets it with `PUT /api/config/default-theme`
([the backend's README](../backend/README.md#the-consoles-look)). The console has no page for it.

### Adding or changing a look

A look is one record in `src/theme/tokens.ts`: its colours, three typefaces, the heading weight, the
corner radius, the button lettering, whether surfaces stay flat, and the shades of each colour when
they must be written out rather than worked out by MUI. `src/theme/createAdminTheme.ts` is the one
place a record becomes a MUI theme.

- Components read only the MUI theme, such as `text.secondary` or `primary.main`, and set a
  monospace value with `sx={{ fontFamily: monoFont }}`. `src/test/theme.test.tsx` fails on a colour
  or a typeface a component writes out, and on a look whose text reads below 4.5:1 against its
  background.
- A new look is a new record and a name in `ADMIN_THEME_NAMES` of web2-admin-common, which
  `src/theme/themeNames.ts` re-exports, so the API checks and stores the host's default by the same
  names.
- The fonts are bundled from `@fontsource`, only the weights used, in `src/theme/fonts.ts`, and a
  browser downloads one only when text on the page is set in it.

## Checks

```bash
pnpm --filter @streaming-monorepo/web2-admin-frontend test       # vitest and jsdom
pnpm --filter @streaming-monorepo/web2-admin-frontend typecheck  # tsc --noEmit
pnpm --filter @streaming-monorepo/web2-admin-frontend lint       # oxlint
pnpm --filter @streaming-monorepo/web2-admin-frontend build      # builds common, typechecks, then vite build
```

`build` builds `../common` first, because its package `exports` map to the TypeScript source only
under the `development` condition, which Vite applies while serving and testing but not in a
production build.

## Production image

`Dockerfile` builds the app and serves it from nginx, with `nginx.conf` doing what the dev proxy
does (`/api` to `api:9877`). Build it from a copy of `apps/web2-admin` made outside the checkout by
`tools/app-workspace/in-copy.mjs`, which carries the admin's own lockfile, cut out of the
repository's root one:

```bash
node ../../tools/app-workspace/in-copy.mjs --app apps/web2-admin -- docker build -f frontend/Dockerfile -t web2-admin-frontend .
```

On a host, `deploy/deploy.sh` builds it for you ([the deploy guide](../deploy/README.md)).

## Layout

```
src/
  main.tsx      the providers: the theme switcher's, the date pickers', the app
  App.tsx       routes
  auth.tsx      session context, re-checks on focus, drops the user on any 401
  api.ts        one function per endpoint
  http.ts       getJson, sendJson, sendBytes, extractApiError
  errors.ts     the API's error codes as sentences
  format.ts     dates, datetime-local conversion, hex elision, the build line
  theme/        the looks as tokens, the MUI theme built from them, the switcher, its saved pick and the host's default
  components/   app shell, build line, route guard, snackbar, chips, copy button, form fields, OBS panel
  pages/        one file per page
  test/         vitest suites and their helpers
```
