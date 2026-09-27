# Server deployment

One host, one checkout, one `docker compose` project per profile: postgres,
the admin API, and the nginx-served console in front of it. Nothing is
published but the console, on the host's loopback. The host's edge, one Caddy
per host set up with `infra/edge/edge.sh`, serves it over HTTPS under its own
name, and an SSH tunnel is the way in without it.

`deploy.sh` is written so streaming-infra-manager can run it the way it runs
swarm-hls-stream's: same flags, standard input closed, output streamed. That
integration is the next step and is not done here; see "What the manager will
call" below.

## One-time host setup

The host runs as user `solarpunk` and keeps the checkout at
`/home/solarpunk/streaming-monorepo`, next to the manager's.

```sh
# As solarpunk@host
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin rsync curl
sudo usermod -aG docker solarpunk
# log out and back in so the group takes effect
```

On your machine you need bash, ssh, rsync and git, and a Host block for the
server in `~/.ssh/config`:

```
Host admin-host
  HostName <server-ip-or-hostname>
  User solarpunk
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

A checkout that deployed before the admin moved into `apps/web2-admin` still
keeps its env files in `web2-admin/backend/`. Move them rather than making new
ones: see "Upgrading from before the move into apps/web2-admin" below.

The script refuses to deploy, before anything leaves your machine, when a key
the API cannot start without is missing or malformed: `POSTGRES_PASSWORD`,
`FEED_PRIVATE_KEY`, `INTERNAL_API_TOKEN` (32 characters or more), `BEE_URL`,
`POSTAGE_BATCH_ID` and `INGEST_HOST`, plus the optional keys the API refuses
when they are set wrong. It warns, and carries on, when a value is still the
sample's: the public Hardhat key, the placeholder token, the all-zero batch,
`ingest.example.com`.

Things that differ from running the API on your laptop:

- `DATABASE_URL`, `WEB2_ADMIN_HOST` and `WEB2_ADMIN_PORT` are set by
  `docker-compose.yml` and whatever the file says is ignored.
- `POSTGRES_PASSWORD` is written into the database URL as it is, so it may
  only hold letters, digits and `. _ ~ -`. It is fixed when the profile's
  database volume is first created; changing it later needs an `ALTER USER`
  in the database as well.
- `BEE_URL=http://localhost:1633` points at the API container itself. A Bee
  node on the same host is `http://host.docker.internal:1633`.
- `WEB2_ADMIN_WEB_PORT` sets the console's port when there is no port slot.

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
deploy.sh --host=<ssh-target> [--profile=<name>] [--portSlot=<N>] [--remote-path=<dir>] [service...]
```

- `--host` is required, and there is no default host. It is an ssh alias,
  `user@host`, or `localhost`. It must start with a letter or digit and hold
  only letters, digits, `. _ @ -`, which is the rule the manager applies to a
  profile's host.
- `--profile` matches `^[a-z0-9][a-z0-9-]{0,30}$`, the manager's profile rule,
  and defaults to `default`.
- `--portSlot` is 1 to 99. See the next section.
- `--remote-path` is an absolute path on the host, default
  `/home/solarpunk/streaming-monorepo`. It is not accepted with
  `--host=localhost`.
- Services are `postgres`, `api` and `web`. None named means all three. Compose
  starts whatever a named service depends on.
- Each flag also takes its value as the next word (`--host admin-host`), as
  swarm-hls-stream's do. An empty value (`--portSlot=`) is an error, never the
  default. Anything else starting with a dash is refused.
- `HEALTH_TIMEOUT` in the environment sets how long the host waits for the
  stack to come up healthy, default 120 seconds.

A deploy:

1. checks the arguments and the env file;
2. writes the commit into `deploy/.deployed-commit`, with `-dirty` appended
   when the working tree has changes;
3. refuses a `--remote-path` that is a non-empty directory but not a checkout
   of this repository, since `--delete` would empty it;
4. rsyncs `apps/web2-admin` to the host with `--delete`, leaving out `.git`,
   `node_modules`, `dist`, build caches, `.scratch/`, `.claude/`,
   `deploy/edge/` (the host's edge, which `edge.sh` looks after), and every env
   file except this profile's and the sample. When the repository keeps its
   one lockfile at its root, the admin's own `pnpm-lock.yaml` and
   `pnpm-workspace.yaml` go with it, cut out of the root's by
   `tools/app-workspace/cut.mjs` into a folder outside the checkout that is
   removed when the deploy exits;
5. over one ssh session, runs `docker compose up -d --build` for the profile's
   project, waits for each service's healthcheck, then asks for `/api/health`
   through nginx from inside the console container.

With `--host=localhost` nothing is sent, and when the root keeps the one
lockfile the two images build from a copy of `apps/web2-admin` made outside the
checkout by `tools/app-workspace/in-copy.mjs`, with the admin's pair cut into
it. Compose still runs from the checkout, so the profile's env file and its
data stay where they are.

The API applies its migrations when it boots, before it listens, so healthy
means migrated and there is no separate step. The commit is also set as the
label `buzz.solarpunk.web2-admin.commit` on the api and web containers, which
is the per-profile answer to "what is running": the file only says what the
shared checkout was last synced to.

The deploy exits non-zero on any failure. When the stack does not come up in
time it prints `docker compose ps` and the last log lines of the services it
deployed before exiting.

### One checkout, many profiles

Every profile on a host shares one checkout, as the manager's profiles share
one, and is kept apart by its compose project: its own network, its own
database volume (`web2-admin-<profile>_pg-data`), its own images and its own
port. Deploying one profile syncs the code for all of them but rebuilds and
restarts only its own; the others pick the new code up at their next deploy.

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

Two deploys to the same host at the same time are not guarded against. They
write into the same tree.

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
with a line saying so. That is swarm-hls-stream's rule.

Why 11009: swarm-hls-stream's slots give every service a last digit, `base +
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

A new database has no users, and every sign-in is refused until one is made.
The script prints this command, once per deploy, filled in for the profile:

```sh
ssh -t admin-host 'cd /home/solarpunk/streaming-monorepo && WEB2_ADMIN_ENV_FILE=../backend/.env.brand-a docker compose -p web2-admin-brand-a -f deploy/docker-compose.yml --env-file backend/.env.brand-a exec api node dist/cli.js user:add <username>'
```

It prompts for the password twice. The first user can manage users. The
console's sign-in page shows the shorter equivalent, `docker exec -it
web2-admin-<profile>-api-1 node dist/cli.js user:add <username>`, to run on
the host; `docker ps` shows the container's name.

### Running compose by hand

`docker-compose.yml` needs `WEB2_ADMIN_ENV_FILE` (the env file's path relative
to `deploy/`) and refuses to run without it, so a hand-run command cannot pick
up the wrong profile's secrets. `WEB2_ADMIN_WEB_PORT` falls back to 9090 when
unset, so anything that recreates the web container, such as `up`, should go
through `deploy.sh`; `ps`, `logs` and `exec` are safe by hand:

```sh
cd /home/solarpunk/streaming-monorepo
export WEB2_ADMIN_ENV_FILE=../backend/.env.brand-a
docker compose -p web2-admin-brand-a -f deploy/docker-compose.yml --env-file backend/.env.brand-a logs -f api
```

On a host deployed to before the move, a profile that has not been deployed
since keeps its env file at the old path, and these commands name that path
instead: see "A profile not yet redeployed" below.

## Upgrading from before the move into apps/web2-admin

Until the admin moved into `apps/web2-admin` it sat at the repository root: a
profile's env file was `web2-admin/backend/.env.<profile>`, and the edge's was
`deploy/edge/.env`. Git moves the files it tracks and leaves ignored ones where
they are, so a checkout that deployed before the move still holds its env files
at the old paths, and so does every host it deployed to.

### On your machine

Move each env file, from the repository root, rather than making a new one from
the sample. A new `POSTGRES_PASSWORD` locks the API out of the profile's
existing database, and a new `FEED_PRIVATE_KEY` makes every publish fail.

```sh
mv web2-admin/backend/.env.brand-a apps/web2-admin/backend/.env.brand-a   # each profile
mv web2-admin/backend/.env apps/web2-admin/backend/.env                   # the default profile, if you use it
mv deploy/edge/.env infra/edge/.env                                       # the edge, if you run it
```

`deploy.sh` and `edge.sh` refuse while a file is only at its old path, and
print the `mv` for it.

### On the host

The host folder is the same, but a profile's env file now lands at
`backend/.env.<profile>`, where it used to land at
`web2-admin/backend/.env.<profile>`. The old copy stays, because every env file
is excluded from rsync's `--delete`, and it keeps a second copy of the
profile's signing key and token. Every deploy of a profile warns, once the
profile is up, while its old copy is still there, and prints the command that
removes it, such as:

```sh
ssh admin-host 'rm /home/solarpunk/streaming-monorepo/web2-admin/backend/.env.brand-a'
```

Nothing removes it for you. Whether and when to remove it is the host owner's
call.

### A profile not yet redeployed

Its env file is still only at the old path on the host, so the commands in "The
first user" and "Running compose by hand" do not find it. Until the profile's
next deploy, name the old path in them:

```sh
cd /home/solarpunk/streaming-monorepo
export WEB2_ADMIN_ENV_FILE=../web2-admin/backend/.env.brand-b
docker compose -p web2-admin-brand-b -f deploy/docker-compose.yml --env-file web2-admin/backend/.env.brand-b logs -f api
```

Its containers keep running meanwhile. Compose read the env file when it
created them, and nothing reads it again until the profile is deployed.

## When a loopback port connects but nothing answers

`ssh -L` accepts the connection and the browser waits forever, while `docker ps`
on the host shows the console healthy on `127.0.0.1:<port>`. Seen on one host in
September 2026. The edge reaches the console the same way, so there its site
times out too, and `edge.sh` reports it as `127.0.0.1:<port>` not answering
within 5 seconds. The forward is a small proxy on the host that opens a second
connection to the container, and that host's persisted firewall
(`/etc/iptables/rules.v4`) accepted Docker's original `172.x` bridges but not
the `10.200.x` pool its `/etc/docker/daemon.json` had handed out since June.
Older projects such as the manager kept working because a network keeps the
subnet it was created with.

To tell: `curl -m 5 http://127.0.0.1:<port>/` on the host itself times out too,
and `docker exec <web container> nc -z -w 3 <bridge gateway> 22` reports the
host as unreachable, while the same against the manager's gateway answers.

The fix is on the host, not in this repo: let INPUT accept traffic from the
Docker bridges (`iptables -I INPUT 1 -i br-+ -j ACCEPT`, then
`netfilter-persistent save`), or whatever narrower rule that host already uses
for the manager's bridge.

## Public HTTPS: the host's edge

One Caddy per host serves the consoles that host publishes on its loopback,
each under its own name with its own Let's Encrypt certificate: this repo's
console, and streaming-infra-manager's when the host runs that too. It is a
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
  when something that is not a container listens there. The usual one is the
  manager's own `public` edge (`manager-edge-1`): empty `MANAGER_DOMAIN` in the
  manager's `manager/.env` and deploy the manager again, which removes it, and
  put the manager's name in this edge's env file instead.
- **The consoles, deployed.** `edge.sh` checks that each one answers on the
  host's loopback, so deploy them first.

Get DNS and the firewall right before the first run. A name that does not
resolve to the host, or a closed port, turns every attempt into a failed
validation, and Let's Encrypt limits those (five an hour per name and account,
at the time of writing) as well as new certificates for the same names (five a
week).

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
ssh -t admin-host 'cd /home/solarpunk/streaming-monorepo && docker compose -p edge -f deploy/edge/docker-compose.yml logs -f'
```

`infra/edge/.env` is gitignored, because the names belong to one deployment.
The sample carries example.org names only.

| Key              | What                                                                                                                           | Default |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `ADMIN_DOMAIN`   | The name the web2-admin console is served at. Empty: not served.                                                               | empty   |
| `ADMIN_PORT`     | The loopback port that console is on, as `deploy.sh` printed: 9090, `WEB2_ADMIN_WEB_PORT`, or `11009 + N*10` with a port slot. | 9090    |
| `MANAGER_DOMAIN` | The name streaming-infra-manager's console is served at. Empty: not served.                                                    | empty   |
| `MANAGER_PORT`   | The loopback port that console is on, the manager's `WEB_PORT`.                                                                | 8080    |
| `ACME_EMAIL`     | Contact address on the Let's Encrypt account. With it set, Caddy also lists ZeroSSL as a fallback authority.                   | empty   |

At least one domain must be set, and a host that runs one console leaves the
other empty. The manager's site is served only when `MANAGER_DOMAIN` is set
here, and only proxied: this does not deploy, configure or restart the manager,
which has its own repository and deploy script.

The grammar:

```
edge.sh --host=<ssh-target> [--remote-path=<dir>]
```

`--host` and `--remote-path` follow `deploy.sh`'s rules, and the remote path is
the same checkout, default `/home/solarpunk/streaming-monorepo`. On a host that
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
   refuses before anything leaves your machine;
2. renders `infra/edge/Caddyfile` from it, one site per name with
   compression, HSTS and `reverse_proxy 127.0.0.1:<port>`, and validates it
   with the pinned Caddy image when Docker runs on your machine;
3. sends the Caddyfile and `infra/edge/docker-compose.yml` to `deploy/edge/`
   in the host's checkout;
4. on the host, refuses when something else holds 80 or 443, recreates the
   edge so Caddy reads the new Caddyfile (the names do not answer for a second
   or two), waits for Caddy to stay running, and asks each console for an
   answer on `127.0.0.1:<port>`;
5. from your machine, asks `https://<name>/` for each name and reports: the
   site answers with a valid certificate; the certificate is still coming; or
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

   `Host` as the browser sent it is what the API compares with `Origin`;
   `X-Forwarded-Proto https` is what makes the session cookie `Secure`; and
   the console's own nginx takes the client address from `X-Forwarded-For`,
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
them; `down -v` deletes them, and every name is then issued again.

The Caddyfile disables Caddy's admin API. On the host's network it would
listen on the host's `127.0.0.1:2019`, where any local user could rewrite the
routes, and a new Caddyfile takes effect by recreating the container anyway.

## What the manager will call

The manager runs a stack's `deploy.sh` with `bash`, standard input from
`/dev/null`, and each line of output streamed to the console:

```
deploy.sh --profile=<name> --portSlot=<N> --host=<target> [service...]
```

with `--host=localhost` for a profile on the manager's own host. This script
takes exactly that and:

- never prompts. ssh runs with `BatchMode=yes` whenever standard input is not a
  terminal, so a missing key or an unknown host key fails at once instead of
  waiting;
- prefixes its own lines with `[deploy]`, errors with `[deploy] ERROR:` on
  standard error, and exits non-zero on every failure;
- refuses a bad argument or env file before any ssh or rsync;
- keeps `--portSlot=<N> (1-99)` in its usage text, the string the manager reads
  a stack's slot ceiling from.

Not decided yet, for that step: where the manager's checkout of this repo
lives and how it writes `apps/web2-admin/backend/.env.<profile>` (it writes a
stack's env file at that checkout's root today); whether it passes the
hls-only flags `--feed-owner`, `--feed-topic` and `--stamp-id`, which this
script refuses; and the `stop.sh`, `health.sh` and `clean.sh` it expects
beside `deploy.sh`, which this repo does not have.

## The scripts' own tests

`test/` runs `deploy.sh` and `edge.sh` in a throwaway checkout, beside a
folder that stands in for the host. Stubs for ssh, rsync, docker, curl, dig
and git come first on `PATH`, so nothing leaves the machine, and the ssh stub
runs commands only in that stand-in host. No package script runs these tests
yet. From the repository root:

```sh
node --test 'apps/web2-admin/deploy/test/*.test.mjs'
```

## Deliberately not here

- **Manager integration.** See the section above.
- **The uploader reaching `/api/internal`.** swarm-hls-stream's uploader calls
  the admin's internal API. Without the edge nothing outside the host reaches
  it. With the edge, nginx passes all of `/api/` through, so
  `https://<ADMIN_DOMAIN>/api/internal` answers from anywhere, guarded by
  `INTERNAL_API_TOKEN` alone (32 characters or more, compared in constant
  time). Whether the uploader should use that route, or the edge should refuse
  it, belongs with the manager integration.
- **Stop, health and clean scripts, and database backups.** Use compose by hand
  (above) until they exist. `down -v` deletes the profile's database.
