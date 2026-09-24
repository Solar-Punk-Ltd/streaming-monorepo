# Server deployment

One host, one checkout, one `docker compose` project per profile: postgres,
the admin API, and the nginx-served console in front of it. Nothing is
published but the console, on the host's loopback, and the team reaches it over
an SSH tunnel, the same as streaming-infra-manager before its TLS edge.

`deploy.sh` is written so streaming-infra-manager can run it the way it runs
swarm-hls-stream's: same flags, standard input closed, output streamed. That
integration is the next step and is not done here; see "What the manager will
call" below.

## One-time host setup

The host runs as user `deploy` and keeps the checkout at
`/opt/streaming/streaming-monorepo`, next to the manager's.

```sh
# As deploy@host
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin rsync
sudo usermod -aG docker deploy
# log out and back in so the group takes effect
```

On your machine you need bash, ssh, rsync and git, and a Host block for the
server in `~/.ssh/config`:

```
Host admin-host
  HostName <server-ip-or-hostname>
  User deploy
```

The host builds the images itself, so it needs to reach the npm registry and
Docker Hub. Nothing is pushed to a registry.

## The env file

Each profile has one env file in `web2-admin/backend/`, and it travels with
every deploy: your checkout is the source of truth, and an edit made on the
host is undone by the next deploy of that profile.

| Profile | Env file | Compose project |
|---|---|---|
| none (`default`) | `web2-admin/backend/.env` | `web2-admin-default` |
| `--profile=brand-a` | `web2-admin/backend/.env.brand-a` | `web2-admin-brand-a` |

Make one from the sample and fill it in:

```sh
cp web2-admin/backend/.env.sample web2-admin/backend/.env.brand-a
```

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

The dev compose file (`web2-admin/backend/docker-compose.yml`, project
`web2-admin`) is a different stack and neither file touches the other.

## Deploying

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
  `/opt/streaming/streaming-monorepo`. It is not accepted with
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
4. rsyncs the checkout to the host with `--delete`, leaving out `.git`,
   `node_modules`, `dist`, build caches, `.scratch/`, `.claude/`, and every env
   file except this profile's and the sample;
5. over one ssh session, runs `docker compose up -d --build` for the profile's
   project, waits for each service's healthcheck, then asks for `/api/health`
   through nginx from inside the console container.

The API applies its migrations when it boots, before it listens, so healthy
means migrated and there is no separate step. The commit is also set as the
label `web2-admin.commit` on the api and web containers, which
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

Two deploys to the same host at the same time are not guarded against. They
write into the same tree.

### `--host=localhost`

No rsync and no ssh: the same steps run in this checkout against the local
Docker daemon. This is what the manager passes for a profile whose host is its
own, and it is also a quick way to try the production stack on a laptop.

## Port slots

| | Console port on the host's loopback |
|---|---|
| `--portSlot=N` | `11009 + N*10` (slot 1 is 11019, slot 3 is 11039, slot 99 is 11999) |
| no slot | `WEB2_ADMIN_WEB_PORT` from the env file, else `9090` |

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
ssh -t admin-host 'cd /opt/streaming/streaming-monorepo && WEB2_ADMIN_ENV_FILE=../web2-admin/backend/.env.brand-a docker compose -p web2-admin-brand-a -f deploy/docker-compose.yml --env-file web2-admin/backend/.env.brand-a exec api node dist/cli.js user:add <username>'
```

It prompts for the password twice. The first user can manage users.

### Running compose by hand

`docker-compose.yml` needs `WEB2_ADMIN_ENV_FILE` (the env file's path relative
to `deploy/`) and refuses to run without it, so a hand-run command cannot pick
up the wrong profile's secrets. `WEB2_ADMIN_WEB_PORT` falls back to 9090 when
unset, so anything that recreates the web container, such as `up`, should go
through `deploy.sh`; `ps`, `logs` and `exec` are safe by hand:

```sh
cd /opt/streaming/streaming-monorepo
export WEB2_ADMIN_ENV_FILE=../web2-admin/backend/.env.brand-a
docker compose -p web2-admin-brand-a -f deploy/docker-compose.yml --env-file web2-admin/backend/.env.brand-a logs -f api
```

## When the tunnel connects but nothing answers

`ssh -L` accepts the connection and the browser waits forever, while `docker ps`
on the host shows the console healthy on `127.0.0.1:<port>`. Seen on one host in
September 2026. The forward is a small proxy on the host that opens a second
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
lives and how it writes `web2-admin/backend/.env.<profile>` (it writes a
stack's env file at that checkout's root today); whether it passes the
hls-only flags `--feed-owner`, `--feed-topic` and `--stamp-id`, which this
script refuses; and the `stop.sh`, `health.sh` and `clean.sh` it expects
beside `deploy.sh`, which this repo does not have.

## Deliberately not here

- **A TLS edge.** The console stays on loopback behind the tunnel. nginx
  already honours `X-Forwarded-Proto` and trusts `X-Forwarded-For` from
  compose networks, so a Caddy service in front, as the manager has, is what
  remains.
- **Manager integration.** See the section above.
- **The uploader reaching `/api/internal`.** swarm-hls-stream's uploader calls
  the admin's internal API, and a console published on loopback only is not
  reachable from its containers or from another host. How the two meet once
  deployed belongs with the manager integration.
- **Stop, health and clean scripts, and database backups.** Use compose by hand
  (above) until they exist. `down -v` deletes the profile's database.
