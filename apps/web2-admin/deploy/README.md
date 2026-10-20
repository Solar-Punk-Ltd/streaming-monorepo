# Deploying the admin

This guide puts the admin on a host and serves its console over HTTPS. A host
runs one checkout and one `docker compose` project per profile, where a profile
is one brand's admin with its own env file and database: Postgres, the admin
API, and the console served by nginx in front of it. Nothing is published but
the console, on the host's loopback. The host's edge, one Caddy per host set up
with `infra/edge/edge.sh`, serves it over HTTPS under its own name, and an SSH
tunnel is the way in without it.

In short:

1. Set up the host once ([One-time host setup](#one-time-host-setup)).
2. Make the profile's env file on your machine ([The env file](#the-env-file)).
3. Run `./deploy/deploy.sh --host=<ssh-target> --profile=<profile>` from
   `apps/web2-admin` ([Deploying](#deploying)). It worked when its last line is
   `deployed <label> (<short commit>)`.
4. Run the first-user command the deploy printed
   ([The first user](#the-first-user)).
5. Serve the console over HTTPS with the host's edge
   ([Public HTTPS: the host's edge](#public-https-the-hosts-edge)).

`deploy.sh` takes the same flags and runs the same way as the stack's deploy
script, with standard input closed and output streamed, so that the manager can
run it. The manager does not run it yet ([Known limits](#known-limits)).

## One-time host setup

The examples run as a user named `deploy` and keep the checkout at
`/opt/streaming/streaming-monorepo`, next to the manager's. Any user in the
`docker` group works, and `--remote-path` puts the checkout anywhere else.

```sh
# As deploy@host
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 rsync curl
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy /opt/streaming
# log out and back in so the group takes effect
```

Ubuntu's own archive names the Compose plugin `docker-compose-v2` and Docker's apt repository names
it `docker-compose-plugin`, so install whichever your sources offer.

The account also needs your own public key in its `authorized_keys`, or no deploy can log in
to it. [What every host needs](../../../docs/self-hosting.md#what-every-host-needs) has the
commands.

On your machine you need bash, ssh, rsync, git and Node 24 or later, which runs
`tools/release/version.mjs` to name the build, and a Host block for the server
in `~/.ssh/config`:

```
Host admin-host
  HostName <server-ip-or-hostname>
  User deploy
```

The host builds the images itself, so it needs to reach the npm registry and
Docker Hub. Nothing is pushed to a registry.

## The env file

Each profile has one env file in `apps/web2-admin/backend/`, and it travels
with every deploy: your checkout is the source of truth, and an edit made on
the host is undone by the next deploy of that profile.

| Profile             | Env file               | Compose project      |
| ------------------- | ---------------------- | -------------------- |
| none (`default`)    | `backend/.env`         | `web2-admin-default` |
| `--profile=brand-a` | `backend/.env.brand-a` | `web2-admin-brand-a` |

Make one from the sample and fill it in, from `apps/web2-admin`:

```sh
cp backend/.env.sample backend/.env.brand-a
```

The script refuses to deploy, before anything leaves your machine, when a key
the API cannot start without is missing or malformed: `POSTGRES_PASSWORD`,
`FEED_PRIVATE_KEY` and `INTERNAL_API_TOKEN` (32 characters or more), plus the
optional keys the API refuses when they are set wrong. It also refuses a
`FEED_PRIVATE_KEY` or an `INTERNAL_API_TOKEN` that is a published test value:
the public Hardhat key, the sample's placeholder token. Anyone could write the stream list
with the one and register stages with the other. A test install can keep them
with `--allow-sample-secrets`, and the script then warns about each one and
deploys.

Funding from the admin has three keys of its own (see "Funding" in
[backend/README.md](../backend/README.md)). `MANAGER_FUNDING_URL` sets it up,
and with it the script refuses a missing `BRAND_WALLET_SECRET` and a
`MANAGER_FUNDING_TOKEN` under 32 characters or with anything in it but
printable ASCII, a space included, as the API refuses them. A
`BRAND_WALLET_SECRET` is held to 64 hex characters whenever it is set, since
the API's first start with one creates the brand wallet under it, and a token
without the address is refused, as the API refuses it. The sample's
`MANAGER_FUNDING_TOKEN` placeholder, and the published placeholder secret
`0123456789abcdef` written four times over, are refused as the published values
above are, and `--allow-sample-secrets` lets a test install keep them. The
sample leaves `BRAND_WALLET_SECRET` commented out, so an env file copied from
it deploys with funding off. No value is printed. The address itself is the API's to judge: one that is not
https, or plain http to this host, stops the API with a sentence in its log,
which the deploy prints when the API does not come up.

An env file that sets a key the admin ignores deploys, with a warning naming
each one. [Retired keys](../backend/README.md#retired-keys) in the backend
README lists them.

`STREAM_RESTART_WINDOW_MINUTES` is how long after a stream ends it can still go
live again on its key, 30 minutes unless set. Then the admin changes the key,
as [Finalizing a stream](../backend/README.md#finalizing-a-stream) in the backend
README says. No host needs a change for it unless it wants another value. The
script does not check it: the API refuses anything but a whole number from 0 to
10080 at its start, with a sentence in its log, which the deploy prints when the
API does not come up.

Nor does the file name the build: `deploy.sh` builds `WEB2_ADMIN_VERSION` and
`WEB2_ADMIN_COMMIT` into the api image (see "The version" below). An env file
that sets either one, even to nothing, is refused, since its value would win
over the image's and the console would name a build nobody made.

Things that differ from running the API on your laptop:

- `DATABASE_URL`, `WEB2_ADMIN_HOST` and `WEB2_ADMIN_PORT` are set by
  `docker-compose.yml` and whatever the file says is ignored.
- `POSTGRES_PASSWORD` is written into the database URL as it is, so it may
  only hold letters, digits and `. _ ~ -`. It is fixed when the profile's
  database volume is first created. Changing it later needs an `ALTER USER`
  in the database as well.
- The api container dials the catalogue node at the Bee API address the
  manager pushes with the catalogue stamp. A loopback address there is the
  container itself, so the manager has to name one the control host's
  containers reach.
- `WEB2_ADMIN_WEB_PORT` sets the console's port when there is no port slot.
- In `MANAGER_FUNDING_URL`, a loopback address is the api container itself. A
  manager on the same host is `http://host.docker.internal:<port>`, which the
  compose file maps to the host, provided the manager's API listens where the
  host's containers reach it. Anywhere else, give its https address.

The dev compose file (`backend/docker-compose.yml`, project `web2-admin`) is
a different stack and neither file touches the other.

## Deploying

From `apps/web2-admin`:

```sh
./deploy/deploy.sh --host=admin-host                              # default profile
./deploy/deploy.sh --host=admin-host --profile=brand-a --portSlot=3
./deploy/deploy.sh --host=admin-host --profile=brand-a api        # the API only
./deploy/deploy.sh --help
```

The full grammar:

```
deploy.sh --host=<ssh-target> [--profile=<name>] [--portSlot=<N>] [--remote-path=<dir>] [--allow-sample-secrets] [service...]
```

- `--host` is required, and there is no default host. It is an ssh alias,
  `user@host`, or `localhost`. It must start with a letter or digit and hold
  only letters, digits, `. _ @ -`, which is the rule the manager applies to a
  profile's host.
- `--profile` matches `^[a-z0-9][a-z0-9-]{0,30}$`, the manager's profile rule,
  and defaults to `default`.
- `--portSlot` is 1 to 99. See the next section.
- `--remote-path` is an absolute path on the host, default
  `/opt/streaming/streaming-monorepo`. It is not accepted with
  `--host=localhost`.
- `--allow-sample-secrets` deploys an env file whose `FEED_PRIVATE_KEY`,
  `INTERNAL_API_TOKEN`, `BRAND_WALLET_SECRET` or `MANAGER_FUNDING_TOKEN` is a
  published test value, with a warning for each. It is for a test install
  only. Without it, any of them refuses the deploy.
- Services are `postgres`, `api` and `web`. None named means all three. Compose
  starts whatever a named service depends on.
- Each flag with a value also takes it as the next word (`--host admin-host`), as
  the stack's do. An empty value (`--portSlot=`) is an error, never the
  default. Anything else starting with a dash is refused.
- `HEALTH_TIMEOUT` in the environment sets how long the host waits for the
  stack to come up healthy, default 120 seconds.

A deploy:

1. checks the arguments and the env file.
2. names the build with `tools/release/version.mjs`, and in a terminal offers
   the tag script first when the commit has no tag (see "The version" below),
   then writes the commit into `deploy/.deployed-commit`.
3. refuses a `--remote-path` that is a non-empty directory but not a checkout
   of this repository, since `--delete` would empty it.
4. rsyncs `apps/web2-admin` to the host with `--delete`, leaving out `.git`,
   `node_modules`, `dist`, build caches, local scratch and editor folders,
   `deploy/edge/` (the host's edge, which `edge.sh` looks after), and every env
   file except this profile's and the sample. When the repository keeps its
   one lockfile at its root, the admin's own `pnpm-lock.yaml` and
   `pnpm-workspace.yaml` go with it, cut out of the root's by
   `tools/app-workspace/cut.mjs` into a folder outside the checkout that is
   removed when the deploy exits.
5. over one ssh session, runs `docker compose up -d --build` for the profile's
   project with the version exported to it, waits for each service's
   healthcheck, asks for `/api/health` through nginx from inside the console
   container, and checks that the api container reports the version just
   built.
6. ends with `deployed <label> (<short commit>)`.

With `--host=localhost` nothing is sent, and when the root keeps the one
lockfile the two images build from a copy of `apps/web2-admin` made outside the
checkout by `tools/app-workspace/in-copy.mjs`, with the admin's pair cut into
it. Compose still runs from the checkout, so the profile's env file and its
data stay where they are.

The API applies its migrations when it boots, before it listens, so healthy
means migrated and there is no separate step. The commit is also set as the
label `web2-admin.commit` on the api and web containers, which
is the per-profile answer to "what is running": the file only says what the
shared checkout was last synced to.

The deploy exits non-zero on any failure. When the stack does not come up in
time it prints `docker compose ps` and the last log lines of the services it
deployed before exiting.

### The version

Before a release the operator tags the commit with the tag script, step 1 of
[docs/releasing.md](../../../docs/releasing.md). A deploy names its build with
`tools/release/version.mjs --app apps/web2-admin` (see
[tools/release](../../../tools/release/README.md)):

- the label is the tag on the commit. On a commit without one, it is the nearest tag
  before it and how many commits past it, such as `v2.4.0+3`, or the short
  commit when no tag is behind it. `-dirty` ends it when `apps/web2-admin`,
  `packages/` or the root's `package.json`, `pnpm-lock.yaml` or
  `pnpm-workspace.yaml` hold changes not yet committed.
- the commit is the full one, which `deploy/.deployed-commit` and the
  containers' `web2-admin.commit` label carry, without `-dirty`: that mark is
  the version label's alone.

Both are held to their patterns before anything leaves your machine: the
commit to 40 lowercase hex characters, the label to 1 to 96 letters, digits
and `. _ + / -`. Anything else is refused, as is a failure of `version.mjs`,
before anything is sent or built.

Run with standard input and output both a terminal, a deploy of a commit with
no tag says `This commit has no tag.` and asks
`Run the tag script now? [y/N]`. On `y` it runs `tools/release/tag.mjs`, then
names the build again and deploys that, whatever the tag script did. On
anything else, and in every run without a terminal, it says in one line that
the commit has no tag and which label it deploys as, and goes on. Nothing is
asked of a run without a terminal, the manager's among them.

The label and the commit reach compose as `WEB2_ADMIN_VERSION` and
`WEB2_ADMIN_COMMIT`, on the host and with `--host=localhost` alike, from the
checkout or from the copy `in-copy.mjs` makes. Compose passes them to both
images as build arguments. The api image keeps them in its environment, where
the API reads them once at boot and answers them, to signed-in users only, at
`GET /api/version`, and the console shows them beside the signed-in account. Both
images carry them as the labels `org.opencontainers.image.version` and
`org.opencontainers.image.revision`. They come last in each Dockerfile, so a
new version rebuilds no layer above them.

Because the version is in the image, a container compose did not replace goes
on reporting the build it runs. Once the stack is healthy the deploy reads the
running api container's `WEB2_ADMIN_VERSION` and `WEB2_ADMIN_COMMIT`, and
fails, saying what it found and what it built, when they are not the build
just made. A deploy that names services without `api` leaves it unchecked and
says so. The last line of a deploy names the build: `deployed <label> (<short
commit>)`, or `deployed <label>` when the label already starts with the short
commit, as an untagged build's does.

### One checkout, many profiles

Every profile on a host shares one checkout, as the manager's profiles share
one, and is kept apart by its compose project: its own network, its own
database volume (`web2-admin-<profile>_pg-data`), its own images and its own
port. Deploying one profile syncs the code for all of them but rebuilds and
restarts only its own. The others pick the new code up at their next deploy.

Env files are the exception to `--delete`. Only the deploying profile's file
is sent, and the rest are excluded, which also keeps them from being deleted:
a laptop that has only `.env.brand-a` must not remove the `.env.brand-b` that
someone else deployed. Removing a profile's env file from the host is
therefore a manual step.

That is rsync's rule: a path an `--exclude` matches is protected from
`--delete` as well, unless `--delete-excluded` is given, which this script
never does. `deploy/edge/` is excluded for the same reason. On the host it
holds the edge's compose file and the Caddyfile `infra/edge/edge.sh` rendered
for this host, and `apps/web2-admin` has no `deploy/edge/` of its own, so
without its own exclude every deploy would delete them. Excluded, the whole
directory is neither sent nor deleted, and a web2-admin deploy never touches
the edge.

### `--host=localhost`

No rsync and no ssh: the same steps run in this checkout against the local
Docker daemon. This is what the manager passes for a profile whose host is its
own, and it is also a quick way to try the production stack on a laptop.

## Port slots

|                | Console port on the host's loopback                                 |
| -------------- | ------------------------------------------------------------------- |
| `--portSlot=N` | `11009 + N*10` (slot 1 is 11019, slot 3 is 11039, slot 99 is 11999) |
| no slot        | `WEB2_ADMIN_WEB_PORT` from the env file, else `9090`                |

With a slot the slot wins, and a `WEB2_ADMIN_WEB_PORT` in the file is ignored
with a line saying so. That is the stack's rule.

Why 11009: the stack's port slots give every service a last digit, `base +
N*10`. Its first block, 10000 to 10009, has no digit left (10009 is the SRS
HTTP API), and its second block uses digits 1 to 6 of 11000 to 11999 for the
per-rung Bee nodes. Digit 9 of the second block is used by no stack service at
any slot, so a console on slot N cannot collide with any stack deployment on
the same host, whichever slot that runs on. The ceiling is 99 for the same
reason it is 99 there: at slot 100 the first block runs into the second.

9090 without a slot, well away from the manager's 8080: both are usually
tunnelled from the same laptop, and a neighbouring number invites a typo.

## Reaching the console

Normally at `https://<name>`, served by the host's edge: see "Public HTTPS: the
host's edge" below. `deploy.sh` does not set that up. `edge.sh` does, once per
host, and a deploy leaves it running.

The tunnel is the fallback, and it works whatever state the edge, its
certificate or DNS are in, since the console is on the host's loopback either
way:

```sh
ssh -L 11039:localhost:11039 admin-host
# then open http://localhost:11039
```

Or add `LocalForward 11039 localhost:11039` to the Host block. The script
prints the exact line at the end of every deploy.

### The first user

Every deploy ends by printing the command that makes the first user, filled in
for the profile, and [The first user](../backend/README.md#the-first-user) in
the backend README says what it does.

### The brand wallet's backup

With `BRAND_WALLET_SECRET` set in the profile's env file, the API creates the
brand wallet on its first start. At handover, print the wallet's private key
once, for the brand's backup:

```sh
ssh admin-host 'cd /opt/streaming/streaming-monorepo && WEB2_ADMIN_ENV_FILE=../backend/.env.brand-a docker compose -p web2-admin-brand-a -f deploy/docker-compose.yml --env-file backend/.env.brand-a exec -T api node dist/cli.js wallet:export --i-understand'
```

There is no `-t` here, unlike the first user's command, which prompts: a
terminal on the host merges standard error into standard output, and the
warning would then travel with the key into a password manager. Without it,
the key alone comes out on standard output and the warning on standard error.

Anyone who holds the key can move everything the wallet holds, so it goes
straight into the brand's password manager and nowhere else, and the command
refuses without `--i-understand`. Keep `BRAND_WALLET_SECRET` with the
profile's env file too: the wallet opens under no other secret, and the API
refuses to start with the wrong one. See "Funding" in
[backend/README.md](../backend/README.md).

### Running compose by hand

`docker-compose.yml` needs `WEB2_ADMIN_ENV_FILE` (the env file's path relative
to `deploy/`) and refuses to run without it, so a hand-run command cannot pick
up the wrong profile's secrets. `WEB2_ADMIN_WEB_PORT` falls back to 9090 when
unset, so anything that recreates the web container, such as `up`, should go
through `deploy.sh`. `ps`, `logs` and `exec` are safe by hand:

```sh
cd /opt/streaming/streaming-monorepo
export WEB2_ADMIN_ENV_FILE=../backend/.env.brand-a
docker compose -p web2-admin-brand-a -f deploy/docker-compose.yml --env-file backend/.env.brand-a logs -f api
```

## Public HTTPS: the host's edge

One Caddy per host serves the consoles that host publishes on its loopback,
each under its own name with its own Let's Encrypt certificate: the admin's
console, and the manager's when the host runs that too. It is a
compose project of its own, `edge`, kept in `infra/edge/` in this repository
and run from `deploy/edge/` in the host's checkout, on the host's network:
Caddy binds ports 80 and 443 itself and reaches `127.0.0.1:9090` and
`127.0.0.1:8080` as the host does, so the consoles stay published on loopback
only and neither console's compose file changes. For two names on one host it
serves, in effect:

```
streaminfra.example.org {
    reverse_proxy 127.0.0.1:8080
}
admin.example.org {
    reverse_proxy 127.0.0.1:9090
}
```

### Before the first run

- **DNS.** An A record for each name, pointing at the host. Add an AAAA
  record only if the host answers on that IPv6 address too: clients that have
  IPv6, Let's Encrypt among them, prefer it.
- **Firewall.** Ports 80 and 443 (TCP) open to the internet in the provider's
  firewall, and 443/UDP as well if you want HTTP/3. Port 80 answers Let's
  Encrypt's challenge and redirects everything else to https.
- **Nothing else on 80 or 443.** Only one process per host can hold them.
  `edge.sh` refuses, naming it, when a container publishes either port, or
  when something that is not a container listens there.
- **The consoles, deployed.** `edge.sh` checks that each one answers on the
  host's loopback, so deploy them first.

Get DNS and the firewall right before the first run. A name that does not
resolve to the host, or a closed port, turns every attempt into a failed
validation, and Let's Encrypt limits those per name and account, as well as new
certificates for the same names.

### Running it

From the repository root:

```sh
cp infra/edge/.env.sample infra/edge/.env
# set ADMIN_DOMAIN and/or MANAGER_DOMAIN, and the ports if they are not the defaults
./infra/edge/edge.sh --host=admin-host
```

Then open `https://<ADMIN_DOMAIN>`. The first certificate takes a moment,
usually under a minute. The run waits up to 90 seconds for it, and ends
without failing if it is not there yet, since Caddy goes on asking in the
background. Watch it on the host:

```sh
ssh -t admin-host 'cd /opt/streaming/streaming-monorepo && docker compose -p edge -f deploy/edge/docker-compose.yml logs -f'
```

`infra/edge/.env` is gitignored, because the names belong to one deployment.
The sample carries example.org names only.

| Key              | What                                                                                                                           | Default |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `ADMIN_DOMAIN`   | The name the web2-admin console is served at. Empty: not served.                                                               | empty   |
| `ADMIN_PORT`     | The loopback port that console is on, as `deploy.sh` printed: 9090, `WEB2_ADMIN_WEB_PORT`, or `11009 + N*10` with a port slot. | 9090    |
| `MANAGER_DOMAIN` | The name the manager's console is served at. Empty: not served.                                                                | empty   |
| `MANAGER_PORT`   | The loopback port that console is on, the manager's `WEB_PORT`.                                                                | 8080    |
| `ACME_EMAIL`     | Contact address on the Let's Encrypt account. With it set, Caddy also lists ZeroSSL as a fallback authority.                   | empty   |

At least one domain must be set, and a host that runs one console leaves the
other empty, so a host that runs the manager alone sets `MANAGER_DOMAIN` only.
The manager's site is only proxied: this does not deploy, configure or restart
the manager, which has its own deploy script, `apps/infra-manager/deploy/deploy.sh`.
This edge is the manager's only HTTPS, since the manager has no edge of its own.

The grammar:

```
edge.sh --host=<ssh-target> [--remote-path=<dir>]
```

`--host` and `--remote-path` follow `deploy.sh`'s rules, and the remote path is
the same checkout, default `/opt/streaming/streaming-monorepo`. On a host that
has no checkout yet, `edge.sh` creates just `deploy/edge/` there, and a later
`deploy.sh` accepts that directory. `--host=localhost` runs it on the machine
it is started on, which must be the server itself: Docker Desktop's host
network is its VM's, not a laptop's. Such a run serves from the `infra/edge/`
of the checkout it was started from, and Caddy mounts the Caddyfile rendered
there rather than one sent to `deploy/edge/`. The folder `deploy.sh` keeps on
a host holds `apps/web2-admin` alone, with no `infra/edge/`, so a local run on
the host needs its own clone of this repository, and the live edge then
mounts that clone's files: remove the clone and the edge fails at its next
restart. `PROBE_TIMEOUT` in the environment sets how long the certificate
probe waits, default 90 seconds, 0 to skip it.

A run:

1. checks the arguments and `infra/edge/.env` (names, ports, email), and
   refuses before anything leaves your machine.
2. renders `infra/edge/Caddyfile` from it, one site per name with
   compression, HSTS and `reverse_proxy 127.0.0.1:<port>`, and validates it
   with the pinned Caddy image when Docker runs on your machine.
3. sends the Caddyfile and `infra/edge/docker-compose.yml` to `deploy/edge/`
   in the host's checkout.
4. on the host, refuses when something else holds 80 or 443, recreates the
   edge so Caddy reads the new Caddyfile (the names do not answer for a second
   or two), waits for Caddy to stay running, and asks each console for an
   answer on `127.0.0.1:<port>`.
5. from your machine, asks `https://<name>/` for each name and reports: the
   site answers with a valid certificate, the certificate is still coming, or
   the name does not resolve, with what `dig +short` says.

It exits non-zero when the edge does not start or stay up, and when a console
behind it does not answer, but not for a certificate that is still on its way.

### A host that already has a web server on 80 and 443

`edge.sh` refuses on such a host, naming what listens there, and that is the
right answer: the console then goes behind the server that is already the
host's front door, as one more name it serves. What that takes, for an nginx
that gets its certificates from certbot's webroot plugin:

1. The name must reach the ACME challenge on port 80. Add it to the
   `server_name` list of the `listen 80` server that has the
   `/.well-known/acme-challenge/` location, and reload. A name missing there
   fails validation, and a multi-name certificate fails renewal for all its
   names at once.
2. `sudo certbot certonly --webroot -w /var/www/certbot -d admin.example.org`
   (the webroot is whatever that location's `root` says).
3. A `listen 443 ssl` server for the name, proxying to the console's loopback
   port with the headers the console reads:

   ```nginx
   server {
       listen 443 ssl;
       server_name admin.example.org;

       ssl_certificate     /etc/letsencrypt/live/admin.example.org/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/admin.example.org/privkey.pem;

       # Thumbnail uploads carry up to 5 MB.
       client_max_body_size 6m;

       location / {
           proxy_pass         http://127.0.0.1:9090;
           proxy_http_version 1.1;
           proxy_set_header   Host              $host;
           proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header   X-Forwarded-Proto https;
       }
   }
   ```

   `Host` as the browser sent it is what the API compares with `Origin`.
   `X-Forwarded-Proto https` is what makes the session cookie `Secure`.
   The console's own nginx takes the client address from `X-Forwarded-For`,
   since the connection reaches it from the Docker bridge gateway.

4. Reload. If that nginx runs in a container with the config bind-mounted as
   a single file, edit the file in place (`cat new.conf > nginx.conf`) rather
   than replacing it: a new inode is invisible to the running container until
   it is restarted.

### Certificates and the two volumes

The certificates and the ACME account key live in the volume `edge_caddy-data`
and Caddy's saved config in `edge_caddy-config`. Every run recreates the
container, and the volumes are why that does not ask Let's Encrypt for new
certificates and run into its limits. `docker compose -p edge -f
deploy/edge/docker-compose.yml down` on the host stops the edge and keeps
them. `down -v` deletes them, and every name is then issued again.

The Caddyfile disables Caddy's admin API. On the host's network it would
listen on the host's `127.0.0.1:2019`, where any local user could rewrite the
routes, and a new Caddyfile takes effect by recreating the container anyway.

## When a loopback port connects but nothing answers

`ssh -L` accepts the connection and the browser waits forever, while `docker ps`
on the host shows the console healthy on `127.0.0.1:<port>`. The edge reaches
the console the same way, so there its site times out too, and `edge.sh`
reports it as `127.0.0.1:<port>` not answering within 5 seconds. The forward is
a small proxy on the host that opens a second connection to the container. This
happens when the host's persisted firewall accepts traffic from Docker's default
`172.x` bridges but the daemon hands out a custom `default-address-pools` range
(set in `/etc/docker/daemon.json`) that the firewall does not name. Projects
created before the pool changed keep working, because a network keeps the
subnet it was created with.

To tell: `curl -m 5 http://127.0.0.1:<port>/` on the host itself times out too,
and `docker exec <web container> nc -z -w 3 <bridge gateway> 22` reports the
host as unreachable, while the same against the manager's gateway answers.

The fix is on the host, not in this repository: let INPUT accept traffic from the
Docker bridges (`iptables -I INPUT 1 -i br-+ -j ACCEPT`, then
`netfilter-persistent save`), or whatever narrower rule that host already uses
for the manager's bridge.

## When the script names an env file at an old path

The admin's env files live in `apps/web2-admin/backend/` and the edge's in
`infra/edge/`. A checkout that still holds one at `web2-admin/backend/` or
`deploy/edge/`, the paths an older layout used, makes `deploy.sh` and `edge.sh`
refuse and print the `mv` that moves it. Run that `mv` from the repository root.
Do not make a new file from the sample instead: a new `POSTGRES_PASSWORD` locks
the API out of the profile's database, and a new `FEED_PRIVATE_KEY` is a new
brand key, which starts a new catalogue no viewer was built for.

On a host, a profile's env file lands at `backend/.env.<profile>`. A copy left
at `web2-admin/backend/.env.<profile>` by the older layout holds a second copy
of the profile's signing key and token, so every deploy of that profile warns
while it is there and prints the `rm` that removes it. Nothing removes it for
you.

## The scripts' own tests

`test/` runs `deploy.sh` and `edge.sh` in a throwaway checkout, beside a
folder that stands in for the host. Stubs for ssh, rsync, docker, curl, dig
and git come first on `PATH`, so nothing leaves the machine, and the ssh stub
runs commands only in that stand-in host. The docker stub keeps the version
each `up` was given and answers it as the api container's environment.
`tools/release/version.mjs` and `tag.mjs` are stand-ins in the throwaway
checkout too, except in the tests that run the real `version.mjs` against a
scratch repository, whose git reads none of the machine's settings. The
admin's `test` script runs them, and from the repository root:

```sh
node --test 'apps/web2-admin/deploy/test/*.test.mjs'
```

## Known limits

- **The manager does not run this script yet.** `deploy.sh` takes the flags
  the manager hands the stack's deploy script, closed standard input included.
  Before the manager can run it, three things are open: where the manager's
  checkout of this repository lives and how it writes
  `apps/web2-admin/backend/.env.<profile>`, whether it passes the stack-only
  flags `--feed-owner`, `--feed-topic` and `--stamp-id`, which this script
  refuses, and the `stop.sh`, `health.sh` and `clean.sh` the manager expects
  beside `deploy.sh`, which the admin does not have.
- **No stop, health or clean script, and no database backup.** Use compose by
  hand ([Running compose by hand](#running-compose-by-hand)) until they exist.
  `down -v` deletes the profile's database.
- **Two deploys to one host at the same time are not guarded against.** They
  write into the same tree.
- **The edge does not filter `/api/internal`.** The stack's uploaders call the
  admin's internal API. Without the edge nothing outside the host reaches it.
  With the edge, nginx passes all of `/api/` through, so
  `https://<ADMIN_DOMAIN>/api/internal` answers from anywhere, guarded by a
  bearer token alone: `INTERNAL_API_TOKEN` (32 characters or more, compared in
  constant time) on the manager's routes, and a stage's own token, known by its
  sha256, on the uploader's. The edge passes it through so that an uploader on
  a stage host can reach the admin at the address the manager's link names.
