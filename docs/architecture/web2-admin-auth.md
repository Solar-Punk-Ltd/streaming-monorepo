# How sign-in works in the admin

This page explains how the admin decides who you are: passwords, sessions, the lockout, the
cross-site check, users and roles, and why each is shaped as it is. It is a concept page. The route
reference is in [the backend's README](../../apps/web2-admin/backend/README.md#sign-in-and-users).

The admin and the manager sign people in the same way, from one shared package,
`packages/web-auth`, so a fix lands in both. Each app passes it its own cookie name and header
value. The manager's page,
[auth-and-public-access.md](../../apps/infra-manager/docs/features/auth-and-public-access.md),
covers the parts only the manager has.

## Passwords

`packages/web-auth/src/passwordHash.ts` hashes with Node's `crypto.scrypt`, no dependency, at
`N = 2^15, r = 8, p = 3`, with a 32-byte salt and a 64-byte key. `maxmem` is raised to 64 MiB,
because Node's 32 MiB default is exactly what `N = 2^15, r = 8` needs for its mixing buffer alone,
and scrypt would otherwise refuse to run. A hash is stored as `scrypt$N$r$p$<salt>$<key>`, so a row
keeps verifying with the parameters it was written with, and the cost can be raised later without
invalidating anything stored.

A password is 12 to 128 characters and must not contain the username. The login body is not
trimmed: a wrong pair answers the same way whatever it looked like, and a username with a space can
never match a row, since the database refuses spaces in usernames.

A sign-in for a username that does not exist is still checked, against a throwaway hash built at
startup, so the time an answer takes does not say which usernames exist.

## Sessions

A session is 32 random bytes, sent as an httpOnly, SameSite=Lax cookie named `web2_admin_session`
on path `/`. The database stores only the sha256 of the cookie value.

The session row is the only clock. A session ends twelve hours after it was last used or fourteen
days after it began, whichever comes first (`packages/web-auth/src/sessionLifetime.ts`).
`last_seen_at` is written at most once a minute, or an open console would cost a database write per
request. The cookie has no `Max-Age` or `Expires`, because a cookie with a deadline of its own would
be a second clock to keep in step.

`Secure` is decided per request, from the first `X-Forwarded-Proto` hop or from the connection
itself, never from a setting. A browser reaching the API over plain http at any address other than
localhost drops a `Secure` cookie, and signing in would then return to the sign-in page with
nothing to show for it.

Ended sessions are pruned on sign-in and by a daily sweep. A password change ends every other
session of that user.

## The lockout

`packages/web-auth/src/LoginLimiter.ts` counts every failed sign-in under the three keys
`signInKeys` gives:

- **The account at that address** (`accountAtAddressKey`), the lowercased username together with
  the client address. Four failures are free. The fifth locks for a minute, every failure after
  that doubles the lock up to an hour, and a right password clears the key.
- **The address** (`clientIpKey`), whatever usernames it tries, on the same curve. One address
  guessing many accounts gets four free failures in all.
- **The account from every address together** (`usernameKey`). 99 failures are free and the 100th
  (`LOGIN_ACCOUNT_CEILING`) locks the account's sign-in for everyone, on the same curve from a
  minute up to an hour. A right password takes back only its own attempt, never the failures made
  from elsewhere. A hundred is the figure NIST SP 800-63B gives. Sessions already signed in keep
  working.

A key with no failure for two hours is forgotten. A locked-out request is `429 too_many_attempts`
with `Retry-After` and `retryAfterSeconds`.

The address is part of the account's key so that a stranger cannot lock you out. Five wrong
passwords from their address lock only that address, and locking your sign-in takes about a hundred
failures, from many addresses. The address on its own still limits one place to four free guesses
across every account it tries, and the hundred limits what many places can guess at one account
together.

The client address is the last `X-Forwarded-For` hop: the edge sets the header, and the console's
nginx restores the visitor's address from it and passes it on. `limiterAddress`
(`packages/web-auth/src/clientIp.ts`) gives the keys their form of it: an IPv4 address as it is, an
IPv4 address written as IPv6 (`::ffff:a.b.c.d`) as that IPv4 address, and an IPv6 address by its
/64 network, written like `2001:db8:0:1::/64`, with any zone dropped, since one machine can take any
address in its /64. Anything that does not read as an address counts as it was sent. The log lines
print the address as it arrived.

An attempt is reserved before the password check starts and settled after it, and reserved attempts
count towards the lockout. So twenty sign-ins sent together cannot all read zero failures and all
get their guess: a test sends twenty and asserts that at most five reached a password check.

A wrong password settles the attempt as a failure, and a right one gives it back and wipes the
account's key (`succeed()`). An error before the outcome, in the user lookup or the hash, gives the
attempt back on every key and wipes nothing (`release()`). So an error leaves no attempt counted,
and forgives no failure made before it, the account's at that address included.

A wrong current password on a password change, or on a write that asks for the password again (a
funding pin or send), counts on the account's key at the address the request came from, like a
failed sign-in from there (`accountAtAddressKey`, with the address each route takes with
`clientIpOf(req)`), so either kind of guess locks both there. It also counts on a key of the user's
own, `confirmationKey`, which sign-in never touches. Four failures are free on it from all
addresses together, shared by the password change, the pin and the send, and the fifth locks them
from every address. A right password takes back only its own attempt from it. So a stolen session
gets four free failures in all, however many addresses it spreads them over, and after that one
guess each time the lock runs out, the wait doubling up to an hour. And a sign-in lockout from
another address, or the one from every address together, does not block them: someone guessing at
the sign-in page cannot stop a signed-in operator from changing their password or confirming a
send.

## The cross-site check

`requireSameSite` runs ahead of the body parser, so a write from another site is refused before its
body is read, as `403 cross_site_request`. It has three layers:

1. The browser's own `Sec-Fetch-Site: cross-site`.
2. The `Origin` host against the `Host` asked for. They are compared by host, not by origin,
   because a TLS edge makes the schemes differ while the host always matches.
3. A mandatory `x-requested-with: web2-admin` header, which no page on another site can add
   without a CORS preflight this API never answers.

GET and HEAD are exempt.

### Why `/api/internal` is outside it

The uploader and the manager are servers. They send no `Origin`, no `Sec-Fetch-Site` and no custom
header, and they authenticate with a bearer token no browser holds. Behind the cross-site check,
every report an uploader makes would be refused, and a broadcast would never go live on the
catalogue. So `src/api/server.ts` mounts `/api/internal` before the check, with a body parser of
its own. A page on another site cannot forge the bearer token either, and a session cookie is never
accepted on those routes. `test/unit/authRoutes.test.ts` and `test/integration/auth.test.ts` hold
it.

## Users and roles

A user is a plain operator or an admin. An admin adds and removes users and signs anyone out.
Everyone can see the list, change their own password and sign themselves out everywhere.

The first user ever added is an admin whatever the caller asked, because somebody has to be able to
add the second. Removing a user runs the count and the delete in one transaction under
`pg_advisory_xact_lock`, so two admins removing each other at once cannot leave a console nobody can
sign in to. The last user and the last admin cannot be removed, and nobody can remove themselves.
A removed user's streams stay, with `user_id` set to null.

Adding a user, removing one, signing a user out and changing a password each write a row to the
audit log, naming who acted and on whom. Signing in and out are not audited: a sign-in has a log
line of its own. No row or log line carries a password, a hash or a token.

## The first user

There is no seeded account and no sign-up route, because a default password is the account an
attacker tries first. A fresh database has no users, and every sign-in answers `401 no_users` until
the first one is made with the `user:add` command, as
[The first user](../../apps/web2-admin/backend/README.md#the-first-user) shows.

`user:add` runs the migrations itself, checks the username before prompting so a bad name is not
found out after the password has been typed twice, prompts twice with echo off, and takes
`--password-stdin` for a password manager's command line. It never takes a password from an
argument or an environment variable.

`GET /api/auth/session` answers 401 either way, `no_users` or `unauthenticated`, so the console can
tell "signed out" from "no users have been made yet".

## The console's side

The console notices a session that ended elsewhere, such as Sign out everywhere, a password change
or a removed user. While someone is signed in, it asks `GET /api/auth/me` again whenever the
operator comes back to the tab, on window focus and when the tab becomes visible, at most once every
five seconds. A 401 signs the tab out with "Your session ended. Log in again." There is no timer,
because every request refreshes `last_seen_at`, so polling would keep an unattended console signed
in past the twelve-hour idle limit. Other tabs of the same browser hear about it at once over a
`BroadcastChannel`.

A reload after a revoke says the same thing. The cookie is httpOnly, so the console keeps a one-bit
mark in `localStorage` while someone is signed in, with no token and nothing about the user. A 401
on the first request with the mark present reads as a session that ended rather than one that never
was. Signing out on purpose clears the mark.

The API has no long-lived connection, such as a stream of server-sent events. Every response ends
within its request, so the session check on each request is the only place an ended session has to
be noticed on the server.

## Where the admin differs from the manager

| The manager                                    | The admin                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| numeric user ids                               | UUIDs                                                                                                                                |
| cookie `sim_session`                           | `web2_admin_session`                                                                                                                 |
| `x-requested-with: streaming-infra-manager`    | `x-requested-with: web2-admin`                                                                                                       |
| `POST /login` answers 204                      | answers `MeResponse`, the signed-in user                                                                                             |
| `POST /users/:id/revoke-sessions`              | `POST /users/:id/revoke`                                                                                                             |
| `locked_out`                                   | `too_many_attempts`                                                                                                                  |
| a password change counts on a key of its own   | a password change, a funding pin and a send count on the sign-in key at the request's address and on the user's own confirmation key |
| no users is 409                                | no users is 401 `no_users`                                                                                                           |
| `GET /auth/users` answers an array             | answers `{ users: [...] }`                                                                                                           |
| server-sent events, closed when a session ends | no long-lived connections                                                                                                            |

## Tests

The shared rules are tested in `packages/web-auth/src/*.test.ts`: hashing, session tokens, the two
session clocks, the lockout (its three keys, the ceiling, a key's own free count and `release()` in
`loginLimiter.test.ts`, how addresses count in `clientIp.test.ts`, and reserved attempts counting
among them), cookies, the cross-site check, the SQL of user removal, and reading a password without
echo.

The admin's own, in `apps/web2-admin/backend/test/unit/` (`pnpm test`):

| File                                | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cookies.test.ts`                   | the cookie's attributes, `Secure` per request and no expiry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `requireSameSite.test.ts`           | every combination of the three headers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `requireAuth.test.ts`               | the gate over real HTTP with in-memory repositories: both clocks, the once-a-minute touch, a removed user's sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `authRoutes.test.ts`                | the routes over real HTTP: no users yet, the cookie, the lockout, a burst of twenty, cross-site refusals, roles, removal races, and `/api/internal` ahead of all of it. Its "the lockout per address" block plays addresses by sending an `x-forwarded-for` header, whose last hop the API takes with no proxy in front: five failures lock the account at one address and it still signs in from another, five across several accounts lock the address, a hundred from many addresses lock the account everywhere, and the password change still works under a lockout at another address and under the ceiling |
| `fundingRoutes.test.ts`             | among the funding routes, a wrong password on a pin or a send: `401` as a password change answers it, a lockout after the fifth on the same count, five wrong confirmations locking sign-in at that address and nowhere else, and a confirmation going through under a lockout at another address and under the ceiling                                                                                                                                                                                                                                                                                           |
| `authAudit.test.ts`                 | the audit rows for user changes: the actor, the target, nothing secret, no row for a refusal, and a failed audit write not failing the change                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `authLimiterLeak.test.ts`           | an error after the limiter reserved an attempt, in the user lookup, leaves no attempt counted and forgives none: five failed lookups, then the right password signs in, and five failed reads, then the right password confirms. Four wrong, then an error, and the next wrong one locks, for sign-in and for a confirmation                                                                                                                                                                                                                                                                                      |
| `authConfirmationLimit.test.ts`     | the account's confirmations from every address together: a stolen session gets four free failures across many addresses, between the password change and a pin or send, and the fifth locks them everywhere while sign-in from elsewhere still works. A right confirmation takes back only its own attempt, and forty wrong sign-ins from ten addresses leave them free                                                                                                                                                                                                                                           |
| `authCredentialConcurrency.test.ts` | a password replaced while a sign-in or a second change was being checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The integration suite (`pnpm test:integration`) starts its own backend with its own database and
covers the CLI-made admin, the session route, the cross-site refusals, the user routes, a password
change ending the other sessions, and the lockout
([its README](../../apps/web2-admin/backend/test/integration/README.md)).
