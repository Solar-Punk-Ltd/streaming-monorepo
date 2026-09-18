# Sign in: the web2-admin login gate

What the admin API does about who you are, ported from streaming-infra-manager's
`docs/features/auth-and-public-access.md` and the code under
`manager/src/domain/auth/`. That page is the reasoning; this one is the port:
what was taken as it stood, what was adapted to this codebase, and what was
deliberately left behind.

Status: landed on `feat/web2admin-auth`, migration `005_auth_users.sql`. The
manager's design has run on a host since 2026-09-11 and is public behind a TLS
edge; this is the same design on a database that already had users in it.

## Why port rather than design

The admin layer had a login already — a users table, a sessions table holding
only the sha256 of the cookie value, scrypt hashes in a self-describing format.
What it did not have was everything around them: one operator was assumed, the
first user came from `SEED_ADMIN_PASSWORD` in a file, sessions never slid or
expired other than on a fixed TTL, the throttle counted only usernames that
existed and could be beaten by sending guesses together, and nothing stopped a
page on another site making the operator's browser publish a stream.

Each of those has an answer in the manager, each answer has a comment saying
which failure it came from, and several of them came from a real incident on a
real host. Writing a second answer would have been writing the same thing twice
and being wrong about a different half of it.

## What was taken unchanged

- **Hashing** (`src/domain/auth/passwordHash.ts`). Node's `crypto.scrypt`, no
  dependency. `N = 2^15, r = 8, p = 3`, 32 byte salt, 64 byte key, `maxmem`
  raised to 64 MiB because node's 32 MiB default is exactly what `N=2^15, r=8`
  needs for its mixing buffer alone and scrypt would otherwise refuse to run.
  Stored as `scrypt$N$r$p$<salt b64>$<key b64>`, which is the format this
  backend already wrote, so **the rows written with the old `N=16384, r=8, p=1`
  keep verifying with the parameters they were written with**. A test pins that
  against a hash built the old way.
- **Sessions, two clocks** (`sessionLifetime.ts`). Idle 12 hours sliding on
  `last_seen_at`, absolute 14 days in `expires_at`, and the session ends at
  `min(expires_at, last_seen_at + idle)`. `last_seen_at` is written at most once
  a minute, or an open console would be a database write per request.
- **The cookie** (`src/api/cookies.ts`). httpOnly, SameSite=Lax, Path=/, and no
  `Max-Age` or `Expires` at all: the sessions row is the only clock, and a
  cookie with a deadline of its own would be a second one to keep in step.
  `Secure` is computed **per request** from the first `X-Forwarded-Proto` hop or
  `req.secure`, never from configuration. That is the manager's bug fix, ported
  with its comment: `Secure` used to be set for any production build, the image
  always is one, and a browser reaching the API over plain HTTP at anything but
  localhost then dropped the cookie it had just been given, so signing in came
  straight back to the sign-in page with nothing to show for it. `COOKIE_SECURE`
  is gone.
- **The limiter** (`LoginLimiter.ts`). Keys are `username:<lowercased>`,
  `ip:<last X-Forwarded-For hop>` and `password-change:<userId>`. Four free
  attempts, the fifth locks for a minute, every failure after that doubles up to
  an hour, and a key with no failure for two hours is forgotten. The important
  part is **reserve-then-settle**: `begin()` increments a pending counter
  synchronously *before* the awaited scrypt, and pending attempts count towards
  the lockout. The `LoginRateLimiter` this replaced read the count and recorded
  the failure on either side of that await, so twenty sign-ins sent together all
  read zero failures and all got their guess. A test sends twenty and asserts at
  most five reached a password check.
- **The decoy hash.** A sign-in for a username that does not exist is still
  checked, against a throwaway hash built at startup, so the clock does not say
  which usernames exist. The old code skipped the hash entirely for an unknown
  name and said so in a comment; that comment is now wrong and is gone.
- **The cross-site check** (`requireSameSite.ts`). Three layers, mounted ahead
  of the body parser so a write from another site is refused before its body is
  read: the browser's own `Sec-Fetch-Site: cross-site`, the `Origin` host
  against the `Host` asked for (compared by host, not origin, because a TLS edge
  makes the schemes differ while the host always matches), and a mandatory
  `x-requested-with: web2-admin` that no cross-origin page can add without a
  CORS preflight this API never answers. GET and HEAD are exempt.
- **Users and roles** (`authSql.ts`, `PostgresUserRepository.deleteUnlessLast`).
  The count and the DELETE run in one transaction under
  `pg_advisory_xact_lock`, because two browsers each removing the other both saw
  two users and both deleted, leaving a console nobody could sign in to. The
  first user ever added is an admin whatever the caller asked, because somebody
  has to be able to add the second.
- **The CLI** (`src/cli.ts`, `src/cli/userAdd.ts`, `src/utils/secretInput.ts`).
  Runs the migrations itself, validates the username before prompting so a bad
  name is not found out after the password has been typed twice, prompts twice
  with echo off, accepts `--password-stdin` for a vault, and takes a password
  from no argument and no environment variable.
- **`GET /auth/session`** answering 401 either way, so the console can tell
  "signed out" from "no users have been created yet".

## What was adapted, and why

| The manager | Here | Why |
| --- | --- | --- |
| `SERIAL` user ids | `UUID` | The table was already UUID-keyed. `userIdParamSchema` matches a UUID, not `^[1-9]\d*$`. |
| `StoredSession` carries `username` and `isAdmin` | carries the whole `UserRow` | `GET /api/auth/me` answers the `User` the contract declares and every stream route reads `req.user.id`; joining the row once is cheaper than a second lookup per request. |
| `SESSION_COOKIE_NAME = 'sim_session'` | `web2_admin_session` | Different product, and the two run on the same laptop. |
| `REQUESTED_WITH_VALUE = 'streaming-infra-manager'` | `web2-admin` | Same. |
| `POST /login` → 204 | → `MeResponse` | The console already had the user from the login answer; taking it away would have been a change to a working contract for nothing. |
| `POST /users/:id/revoke-sessions` | `POST /users/:id/revoke` | Shorter, and nothing was using the longer name yet. |
| `LockedOutError` → `locked_out` | `TooManyAttemptsError` → `too_many_attempts` | The console already renders that code. The body gained `retryAfterSeconds` beside the `Retry-After` header, as in the manager. |
| `NoUsersError` → 409 | → 401 | It is an answer to "who am I", and the console's fetch wrapper already treats `/auth/session` and `/auth/login` as routes where a 401 is an answer rather than an eviction. |
| `GET /auth/users` → a bare array | → `{ users: [...] }` | `UserListResponse` in web2-admin-common. |
| One password check throttled per route | Same, but the wrong *current* password answers 401 `invalid_credentials` | The manager's choice, kept: the console's wrapper exempts `/auth/password` from the sign-out-on-401 rule for exactly this case. |
| `manager/src/domain/auth/*` | `web2-admin/backend/src/domain/auth/*` | Same shape, under this repo's `src/domain/`. |

The login body is **not** trimmed, which the old `loginSchema` did. That is the
manager's choice and the reason is in its comment: a wrong pair must answer the
same way whatever it looked like. A username with a space in it could never
match a row anyway — the CHECK forbids spaces.

## What was deliberately left out

**`OpenStreams` and `streamRevalidation`.** The manager holds a registry of open
Server-Sent Events connections and closes the ones whose session has been signed
out, revoked, removed or has idled past its deadline, on a timer. It needs that
because a stream outlives the request that opened it: a page doing nothing but
listening would otherwise keep receiving deployment events after its session had
ended, and no request would ever come along to notice.

web2-admin has no SSE and no long-lived connection of any kind. Every response
ends within its request, so `requireAuth` is the only place an ended session has
to be noticed, and it notices on the next request. Porting `OpenStreams` would
have been a registry that never held anything and a timer that never closed
anything. **It is absent on purpose, not by oversight.** If this backend ever
grows a live-updates stream, that is the moment to port both files — the
manager's `AuthService.closeStreamsOfEndedSessions` is the whole of it, and the
comment there about a stream deliberately not counting as activity is the part
that is easy to get wrong.

Also left out, with less to say about them: the manager's Caddy edge, its nginx
security headers and its host firewall generator. Those are deployment, this is
the API, and web2-admin's own deployment story is `docs/infra-state.md`.

## The surface

Everything is under `/api`. The open routes are `GET /api/health`,
`GET /api/config`, all of `/api/internal`, and `POST /api/auth/login`,
`POST /api/auth/logout` and `GET /api/auth/session`. Everything else needs a
session.

| Method | Path | Who | Answer |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | anyone | `MeResponse` + the cookie; 401 `invalid_credentials`, 401 `no_users`, 429 `too_many_attempts` |
| POST | `/api/auth/logout` | anyone | 204, cookie cleared, session row deleted |
| GET | `/api/auth/session` | anyone | `MeResponse`; 401 `no_users` when the table is empty, 401 `unauthenticated` otherwise |
| GET | `/api/auth/me` | signed in | `MeResponse` — kept for compatibility |
| POST | `/api/auth/password` | signed in | `MeResponse`; 401 `invalid_credentials`, 400 `validation_error`, 429 |
| GET | `/api/auth/users` | signed in | `UserListResponse` |
| POST | `/api/auth/users` | admin | 201 `UserSummary`; 409 `user_exists`, 400 `validation_error`, 403 `admin_required` |
| DELETE | `/api/auth/users/:id` | admin | 204; 409 `cannot_remove_user` (yourself, the last user, the last admin), 404 `user_not_found` |
| POST | `/api/auth/users/:id/revoke` | admin, or yourself | 204; 403 `admin_required`, 404 `user_not_found` |

New error codes: `cross_site_request` 403, `admin_required` 403, `no_users` 401,
`user_exists` 409, `user_not_found` 404, `cannot_remove_user` 409, and
`too_many_attempts` 429 now carries `retryAfterSeconds` beside `Retry-After`. A
weak password or a bad username is a 400 `validation_error` with the reason in
`errors`, the same shape a schema rejection has. No token is logged anywhere.

## `/api/internal` is outside the cross-site check

The uploader is a machine. swarm-hls-stream posts from a server with no
`Origin`, no `Sec-Fetch-Site` and no custom header, and it authenticates with a
bearer token no browser holds. Behind `requireSameSite` every report it makes
would be a 403 and the live streaming loop would stop: a broadcast would never
flip to `live` and its catalogue entry would never be rewritten.

So `/api/internal` is mounted in `src/api/server.ts` **before**
`app.use(requireSameSite)`, with a body parser of its own, and the check never
sees those requests. It costs nothing: a page on another site cannot forge the
bearer token either, and a session cookie is never accepted on those routes.
Two tests hold it — one in `test/unit/authRoutes.test.ts` against a harness
wired the same way, one in `test/integration/auth.test.ts` against the real
server.

## No seeding

`SEED_ADMIN_USERNAME` and `SEED_ADMIN_PASSWORD` are gone, with the `seedAdmin.ts`
that read them. A password in a file is a password, and a default one that
nobody changes is the account an attacker tries first.

A fresh database has no users. The API boots, logs a warning, answers
`/api/health`, `/api/config` and `/api/internal`, and refuses every sign-in with
401 `no_users` until:

```bash
pnpm user:add owner                 # prompts twice, echoes nothing
# or, in the image:
docker compose exec -it api node dist/cli.js user:add owner
# or from a vault, with the password never in a file or an argv:
op read "op://<vault>/<item>/password" \
  | docker compose exec -T api node dist/cli.js user:add owner --password-stdin
```

The first user is an admin whatever the flags said. Later ones are plain unless
an admin passes `--admin`, or `admin: true` on `POST /api/auth/users`.

## Migration 005 on a database that was already in use

`005_auth_users.sql` adds `users.is_admin` (defaulting false), `users.last_login_at`,
a username CHECK mirroring `USERNAME_RE`, and `sessions.last_seen_at`,
`sessions.ip`, `sessions.user_agent`. Two details matter on an existing install:

- The oldest user is set to `is_admin = true` before the CHECK is added, so the
  account the console was set up with keeps being able to manage users.
- `last_seen_at` defaults to `NOW()`, which is the kindest reading: whoever is
  signed in when the migration runs stays signed in.

An existing username that the CHECK would refuse would fail the migration. The
one install this landed on had a single user, `admin`, which it accepts.

## Tests

Unit (`pnpm test`, `node:test` under tsx):

| File | What it pins |
| --- | --- |
| `passwordHash.test.ts` | round trip, wrong passwords, the recorded parameters, **an old-parameter hash still verifying**, salting, an unreadable row refusing everyone |
| `sessionToken.test.ts` | 32 random bytes as base64url, sha256, hash ≠ token |
| `sessionLifetime.test.ts` | 12 hours idle, 14 days absolute, the earlier clock winning, the one-minute touch throttle |
| `loginLimiter.test.ts` | the schedule, the countdown, forgetting, per-key isolation, the shared-key give-back, **pending attempts counting**, eviction at the cap, the password-change key |
| `cookies.test.ts` | the hand-written parser's edges, and the cookie's attributes including `Secure` per request and no expiry |
| `requireSameSite.test.ts` | every combination of the three headers |
| `requireAuth.test.ts` | the gate over real HTTP with in-memory repositories: both clocks, the touch throttle, a removed user's sessions |
| `authRoutes.test.ts` | the routes over real HTTP: the empty-users state, the cookie, the lockout as an operator meets it, a burst of twenty, cross-site refusals, roles, user removal races, and `/api/internal` reachable in front of all of it |

Integration (`pnpm test:integration`) starts **its own backend**: its own
database, its own port, `FEED_GATEWAY=fake`, and a first user made by running
the `user:add` CLI. It never talks to the development backend on :9877, which
runs against a real Bee node and the real catalogue. `test/integration/auth.test.ts`
covers the CLI-made admin, the session route, the cross-site refusals, the user
routes, a password change dropping the other sessions, and the lockout.
