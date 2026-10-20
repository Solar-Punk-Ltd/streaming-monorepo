# Sign-in and public access

The manager's console and API sit behind a login. Every user signs in with a username and a
password, and some users are admins who may add and remove the others. This page is a feature page
of the manager (`apps/infra-manager`, the web console and API that deploys the streaming stack,
`apps/hls-stream`, onto hosts). It covers the login gate, the Access page, and what keeps a
manager safe once it answers on a public name: the HTTPS edge, the API binds of the stack and the
host firewall. The steps that open a manager to the internet are in
[Opening the manager to the internet](../../deploy/README.md#opening-the-manager-to-the-internet)
in the deploy guide.

## What it does

### Users and admins

A **user** is a username and a password hash in the manager's database. There is no sign-up. The
first user is created on the host with a command (see [The first user](#the-first-user)), and
admins add the rest from the Access page.

- A username is 2 to 32 characters of `a-z`, `0-9`, dot, underscore or dash, starting with a
  letter or a digit (`USERNAME_RE` in `packages/web-auth/src/rules.ts`). The database holds the
  same rule as a check constraint.
- A password is 12 to 128 characters (`PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`). Anything
  printable is allowed and there are no composition rules. It must not contain the username.
- A password is stored as an scrypt hash written as `scrypt$N$r$p$<salt>$<key>`, with
  `N = 2^15, r = 8, p = 3` (`CURRENT_PARAMS` in `packages/web-auth/src/passwordHash.ts`), a 32
  byte random salt and a 64 byte key. The parameters travel with each hash, so they can be raised
  without invalidating stored passwords.

An **admin** is a user who can manage users: add one, remove one, and sign someone else out.
"Who can manage users" under [Endpoints](#endpoints) has the rules.

### Sessions

Signing in opens a **session**. The browser holds its token in the cookie `sim_session`
(`SESSION_COOKIE_NAME`), marked `HttpOnly`, `SameSite=Lax` and `Path=/`. The token is 32 random
bytes. The database stores only its SHA-256, so a copy of the sessions table signs nobody in.

- `Secure` is set when the browser reached the manager over HTTPS: the edge says so with
  `X-Forwarded-Proto: https`, or the connection itself is TLS. Over the plain HTTP of an SSH
  tunnel the cookie is not marked `Secure`, because the browser would drop it and sign-in would
  loop.
- A session has two clocks, and the earlier one ends it. It ends after twelve hours without a
  request (`SESSION_IDLE_TIMEOUT_MS`) and fourteen days after sign-in however busy it was
  (`SESSION_ABSOLUTE_TIMEOUT_MS`). The idle clock is written at most once a minute
  (`LAST_SEEN_REFRESH_MS`), so a request is not a write.
- The cookie has no expiry of its own. The session row is the only clock.
- Expired sessions are deleted at each sign-in and by a daily sweep
  (`manager/src/domain/auth/sessionSweep.ts`).
- Ending a session also closes the live event streams it opened. Signing out, a revoke, removing a
  user and changing a password close them at once. A session that runs out has its streams closed
  within a minute (`manager/src/domain/auth/streamRevalidation.ts`). An open stream does not count
  as activity, so a page left open idles out like any other.
- Changing your password signs out every other session of yours. The one you changed it from
  stays.

### Lockout

Failed sign-ins are counted per username and per client address, in memory in the API process
(`LoginLimiter` in `packages/web-auth`).

- Four failures are free (`LOGIN_FREE_ATTEMPTS`). The fifth locks the key for one minute
  (`LOGIN_FIRST_LOCKOUT_MS`), and each further failure doubles the wait, up to one hour
  (`LOGIN_MAX_LOCKOUT_MS`).
- A locked attempt answers 429 with `Retry-After`. The sign-in page says how long to wait.
- A key with no failure for two hours starts again from zero (`LOGIN_FORGET_MS`).
- A right password clears the username's count. It takes only its own attempt off the address,
  so one good sign-in does not reset an address that is guessing other accounts.
- Every failure is logged with the username and the address.
- A sign-in for a username that does not exist is checked against a throwaway hash, so it takes
  as long as one for a real user.
- The current password asked by a password change is counted the same way, on a key of its own,
  so a stolen session cannot guess the password behind it without limit.
- At most 10,000 keys are held (`MAX_TRACKED_KEYS`). Past that, the keys that failed longest ago
  are dropped first.

The client address is the last hop of `X-Forwarded-For`, which the manager's web server sets. In
front of the API, that web server also limits `/auth/login` to ten requests a minute per address
with a burst of five, and answers 429 past it. This stops a flood before each attempt pays for a
slow scrypt hash.

### The write header

Every request that changes something (anything but `GET` and `HEAD`) must carry the header
`X-Requested-With: streaming-infra-manager` (`REQUESTED_WITH_VALUE`). The console's fetch wrapper
adds it. A page on another site cannot add it without a CORS preflight, and the manager answers
no preflight and sets no CORS headers.

A write is refused with 403 `cross_site_request` when any of these holds:

- `Sec-Fetch-Site` says `cross-site`.
- `Origin` is present and names a host other than the `Host` the request was sent to.
- The header above is missing or has another value.

The gate runs before the request body is read. `SameSite=Lax` on the cookie is the first layer: a
browser does not send it on a cross-site POST. Reads are never refused, because they change
nothing and `EventSource` cannot set headers.

### What stays open

Four routes answer without a session: `GET /health`, `POST /auth/login`, `GET /auth/session` and
`POST /auth/logout`. Every other route needs one, both Server-Sent Events streams, `/config`,
`/version` and `/metrics` included.

`GET /health` runs a database query and answers `{"status":"ok"}` and nothing else. Docker's
healthcheck for the `api` service reads it every 30 seconds after a 60 second start period, and
`manager:upgrade` waits on it during a deploy.

The web2 admin's funding API under `/api/admin-funding` has a credential of its own. See
[Endpoints](#endpoints).

## Using it in the console

### Signing in

Opened without a session, the manager shows one page, **Sign in**, with Username, Password and a
**Sign in** button.

- A wrong pair reads `Wrong username or password.`, never which half was wrong.
- A locked key reads `Too many attempts. Try again in 4 minutes.`, with the wait the API returned.
- With no users yet it reads `No users yet. Create the first one on the host.` and shows the
  command from [The first user](#the-first-user).
- When the API answers 401 during a session (revoked or expired), the console returns to Sign in
  with `Your session ended. Sign in again.`

Signed in, the sidebar footer shows your username and a **Sign out** item.

### The Access page

**Access** in the sidebar (`#/access`) is there for every signed-in user. Its first line says
`A session lasts twelve hours of inactivity, and fourteen days at most.`

- The **Users** card lists every user with their last sign-in (or `Never`) and their open
  sessions. `manages users` marks each admin and `you` marks your own row. Each row has a **Sign
  out everywhere** and a **Remove** button. Both ask for confirmation.
- The **Change my password** card takes the current password and the new one twice.
- An admin reads `You can add and remove users here.` and gets the **Add user** card: a username,
  a starting password typed twice, and the box
  `Can manage users: add and remove them, sign anyone out`. Hand the starting password over in
  person. An admin's own Remove button is disabled.
- Anyone else reads `Only a user who can manage users adds or removes one.` and gets no Add user
  card. Remove is disabled on every row, and Sign out everywhere on every row but their own, each
  with a tooltip saying why.
- Sign out everywhere is disabled on a row with no open sessions.

### The first user

The first user is created on the host, in the api container:

```bash
docker compose exec -it api node dist/cli.js user:add <username>
```

It asks for the password twice with nothing echoed and writes only the hash. It runs the database
migrations first, so it works before the API has started. When stdin is not a terminal it
refuses, unless `--password-stdin` is given, which reads the password from a pipe:

```bash
<command that prints the password> | docker compose exec -T api node dist/cli.js user:add <username> --password-stdin
```

`--admin` makes the new user an admin. The first user ever added is an admin whether the flag is
given or not. There is no environment variable and no seed file for a password, so a password never
lands in a file or a process argument. Step 5 of the
[deploy guide](../../deploy/README.md#5-create-the-first-user) has the host-side steps.

## Endpoints

`manager/src/api/routes/auth.ts`, all JSON, all bodies validated with yup:

| Method | Path                              | Body                             | Answer                                                                                                                 |
| ------ | --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`                     | `{ username, password }`         | 204 and the cookie, 401 `invalid_credentials`, 429 `locked_out`, 409 `no_users` when none has been created             |
| POST   | `/auth/logout`                    |                                  | 204, cookie cleared, session row deleted. Also 204 without a valid session, so a stale cookie is cleared               |
| GET    | `/auth/session`                   |                                  | `{ id, username, isAdmin, expiresAt }`, or 401 with `not_signed_in` or `no_users`                                      |
| POST   | `/auth/password`                  | `{ current, next }`              | 204, every other session of yours revoked. 401 wrong current password, 429 locked                                      |
| GET    | `/auth/users`                     |                                  | `[{ id, username, isAdmin, createdAt, lastLoginAt, sessions }]`                                                        |
| POST   | `/auth/users`                     | `{ username, password, admin? }` | 201 and the new user's row, 403 `admin_required` unless you are an admin, 409 taken                                    |
| DELETE | `/auth/users/:id`                 |                                  | 204, 403 `admin_required` unless you are an admin, 404 no such user, 409 for yourself, the last user or the last admin |
| POST   | `/auth/users/:id/revoke-sessions` |                                  | 204 for your own id, and for anyone's if you are an admin, otherwise 403 `admin_required`. 404 no such user            |

A username or password that breaks the rules answers 400 `validation_error` with the reason. The
middleware `requireSession` (`manager/src/api/middleware/requireSession.ts`) runs before every
router except `/health`, `/auth` and the funding API. It attaches the signed-in user to the
request and clears a cookie that no longer opens a session. The request log names the user, never
the token. The full API is in the [API reference](../../manager/README.md).

**Who can manage users.** A user may be an admin, `isAdmin` in the answers above. Through the API
only an admin adds a user, removes one or signs someone else out, and anyone else gets 403
`admin_required` (`requireAdmin`, in the same file as `requireSession`, and a check inside the
revoke route). Every signed-in user lists the users, changes their own password and signs
themselves out everywhere. A user is made an admin when added, and no route or command changes
that later: `user:add --admin` on the host, or `admin: true` on `POST /auth/users` from an admin,
which is the Add user card's "Can manage users" box. The first user ever added is an admin
whatever was asked, so the account created with the command can add the next. On a database
whose users predate the admin role, the oldest user is the admin. The last admin cannot be
removed.

The role gates those three actions and nothing else. `requireAdmin` is used in
`manager/src/api/routes/auth.ts` alone, so every other route in `manager/src/api/server.ts` is
open to any signed-in user. That includes deploying and stopping a deployment, buying a stamp, a
chequebook deposit or withdrawal, engine settings and config files, restarting containers and
reading an SRT passphrase.

**The funding API's credential.** The routes under `/api/admin-funding`, which the web2 admin calls
server to server, take `Authorization: Bearer <FUNDING_API_TOKEN>` and refuse a session cookie.
While `FUNDING_API_TOKEN` is unset they answer 404 `funding_off`. They are mounted ahead of the
write header gate and `requireSession`. Right after them, `refuseFundingBearer` makes every other
route answer 401 to a request that carries a bearer token, `/health` and `/auth` included, so
neither credential opens the other's routes. The rules and routes are
[Funding API](../../manager/README.md#funding-api) in the API
reference.

## What a signed-in user can read

- A deployment's private key is never returned. The deployment's JSON carries `has_private_key`
  instead.
- A deployment's SRT passphrase is not in its JSON either, only `has_srt_passphrase`. It is
  answered one deployment at a time by `GET /profiles/:name/srt-passphrase`, with
  `Cache-Control: no-store`. The console asks for it when the publish URL is opened or copied.
  Each read is logged with who read which deployment's.
- Reading a deployment's effective engine config, which holds the passphrase in clear, is logged
  the same way.
- When a deployment's passphrase changes, the publish URL drops the old one at once. The Publish
  card's copy control waits until the new one has arrived, so it never copies a stale or partial
  URL.
- `GET /config` answers the host-wide SRT passphrase to any signed-in user.

## Opening the manager to the internet

The manager has three layers between a browser on the internet and the things it controls. The
login above is one. The others are HTTPS in front, and closing the stack's own ports, which ask
for no password. The order matters: a login on the manager protects nothing while a Bee node's API
sits open beside it, because that API can spend the node's postage and, with a whitelist, send its
money away. The deploy guide's
[Opening the manager to the internet](../../deploy/README.md#opening-the-manager-to-the-internet)
has the steps and commands in the order to run them.

### How the manager is reached

- The `web` container (nginx, serving the console and proxying the API) publishes one port,
  `WEB_PORT`, on `MANAGER_WEB_BIND`, which is `127.0.0.1` unless set.
- The `api` container publishes nothing. `web` reaches it on the compose network.
- Postgres publishes nothing.
- Without an edge, you reach the console through an SSH tunnel to that loopback port. The tunnel
  stays the way back in when the edge is down or its certificate is stuck.

### The HTTPS edge

The manager has no HTTPS of its own. The host's edge in `infra/edge/` does it: one Caddy per host,
serving every console the host runs under its own name, with a certificate from Let's Encrypt. It
sends `Strict-Transport-Security` with `includeSubDomains` for a year, so give the manager a name
of its own rather than an apex domain that serves other things.

The edge sends `X-Forwarded-Proto: https`, and nginx passes it on, which is how the manager knows
to mark the cookie `Secure`. nginx trusts `X-Forwarded-For` from the private address ranges, where
the edge talks to it from, so the lockout sees the browser's address and not the edge's.

nginx adds these headers to every response:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

`style-src 'unsafe-inline'` is there because MUI writes its styles into the page at runtime.
Every script is bundled, so `script-src 'self'` holds.

### The API binds

Each stack deployment publishes the API of each Bee node it runs and the HTTP ports of its
engines. None of them asks for a password. Docker publishes a container port with rules of its
own, which a host firewall such as ufw never sees. So the stack's deploy binds each of them to
the host's Docker bridge address wherever its `*_BIND` setting is empty. Containers on the host,
the manager's `api` among them, reach that address as `host.docker.internal`, and nothing outside
the host reaches it.

Do not set these to `127.0.0.1` for the Bee ports or OME's HLS port on a Linux host. The manager
reaches them through `host.docker.internal`, so loopback cuts off stamp management and engine
rollout checks for every deployment on the host without an error that names the cause. The eight
keys, where they live, and `BEE_LOCAL_HOST` for a bridge the manager reaches by another address
are in the deploy guide's step 2.

### The host firewall

`deploy/host/firewall-rules.sh` prints a draft nftables table, `inet streaming_infra_manager`, and
applies nothing. It needs the external interface (`--iface`) and an inventory export downloaded
from the signed-in manager at `/targets/firewall?alias=<alias>` (`--inventory`), and refuses to
print without either. The draft replaces only its own table.

- The input chain defaults to deny. It allows SSH, 80 and 443 over TCP, 443 over UDP for the
  edge's HTTP/3, and the public stack ports.
- The forward chain covers the ports Docker publishes for containers, which an input chain never
  sees. It matches the original destination port, before Docker rewrote it.
- In the stack's port range, 10000 to 19999 (`PROTECTED_PORT_MIN`, `PROTECTED_PORT_MAX`), four
  bands are public, one per role, each moving by ten per slot (`PORT_SLOT_STRIDE`) for up to 100
  slots (`MANAGER_SLOT_CAP`): SRT ingest on UDP (`10001`), the viewer page (`10004`) and the two
  Bee peer ports (`10006`, `10008`), from `PUBLIC_PORT_ROLES` in `common/src/portPolicy.js`.
  Everything else in the range is dropped: the Bee APIs, the uploader API, the engines' HTTP ports,
  RTMP and the SRS API.
- `--bee-api-source <address>/32` opens a slot's Bee API port to named addresses only, for a Bee
  host whose nodes serve uploaders on other hosts.

So the three controls work together: the API binds keep the unprotected ports on the bridge, the
forward chain drops everything else Docker publishes, and the input chain covers the host itself.
Step 3 of the deploy guide has the command and what to check in the draft.

## Settings

Keys in `manager/.env`:

| Key                 | Default                | What it does                                                                                                                             |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PORT`          | `8080`                 | The host port the console is published on                                                                                                |
| `MANAGER_WEB_BIND`  | `127.0.0.1`            | The host address `WEB_PORT` is published on. Docker publishes past a host firewall, so widen it only behind one                          |
| `FUNDING_API_TOKEN` | none                   | The web2 admin's bearer token for `/api/admin-funding`. Unset turns that API off                                                         |
| `BEE_LOCAL_HOST`    | `host.docker.internal` | The address the manager reaches a local Bee node's API and OME's HLS port on. Set it when the binds name something other than the bridge |

The stack's `*_BIND` and `*_API_LISTEN` keys are in the deploy guide's step 2. The manager's other
settings are in the [API reference](../../manager/README.md).

## Limits

- The login does not yet offer two-factor sign-in or single sign-on.
- There is no password reset. A user who forgets theirs is removed by an admin and added again.
- A user's admin role cannot be changed after the user is added.
- The admin role gates user management only. Every signed-in user can deploy, spend postage and
  chequebook funds, and read SRT passphrases.
- The lockout lives in the API process's memory, so a restart clears it.
- `GET /config` answers the host-wide SRT passphrase to any signed-in user.
- The firewall generator prints a draft. Applying it is the host operator's step.
- The firewall draft opens no RTMP port. A host that takes broadcasts over RTMP needs that port
  opened by hand.
