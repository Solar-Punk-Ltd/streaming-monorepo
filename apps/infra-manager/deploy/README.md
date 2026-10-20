# Deploying the manager

This guide puts the manager, `apps/infra-manager`, on a server. The server runs three containers
in one Compose project called `manager`: Postgres, the manager's API (`api`) and nginx serving the
console (`web`). Nothing is published to the internet. You reach the console through an SSH tunnel,
and later, if you want, through the host's HTTPS edge (see
[Opening the manager to the internet](#opening-the-manager-to-the-internet)).

The examples use a user called `deploy` and keep the manager at
`/opt/streaming/streaming-infra-manager`. `<control-host>` is the SSH alias you give the server
that runs the manager.

## 1. Prepare the server

On the server, as a user with `sudo`:

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 rsync curl
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy /opt/streaming
```

Log out and back in so the group takes effect. Ubuntu's archive names the Compose plugin
`docker-compose-v2`, Docker's own apt repository names it `docker-compose-plugin`, so install
whichever your sources offer.

Put your own public key in the `deploy` user's `authorized_keys`.
[What every host needs](../../../docs/self-hosting.md#what-every-host-needs) has the commands.

Any user in the `docker` group works. `MANAGER_ROOT` in the env file puts the manager in another
folder. The data, the stack versions and the SSH identity default to folders beside it, and
`BEE_DATA_ROOT`, `STACK_VERSIONS_ROOT` and `MANAGER_SSH_DIR` move each of them.

## 2. Write the env file

On your machine, in your checkout:

```sh
cp manager/.env.sample manager/.env
```

Set at least `POSTGRES_PASSWORD`, to a value of your own, for example from
`openssl rand -hex 24`. The sample ships `pwd`, which is public, and the deploy refuses it. A test
install can keep it with `--allow-sample-secrets`, which deploys with a warning.
`manager/.env.sample` describes every key, and
[the API and settings reference](../manager/README.md#environment) lists them all. Every deploy
sends this file to the server, so your checkout is the only source of truth for it: an edit made
on the server is undone by the next deploy.

### Which env file a deploy sends

One, which the server keeps as `manager/.env`. Without `--profile` it is `manager/.env`. A server
whose settings differ gets a file of its own, made from the same sample, and
`--profile=<name>` sends `manager/.env.<name>` in its place:

```sh
cp manager/.env.sample manager/.env.staging
./deploy/deploy.sh --host=<staging-host> --profile=staging
```

The name follows the rule for a deployment name, `^[a-z0-9][a-z0-9-]{0,30}$`, and `default` means
`manager/.env`. A missing file stops the deploy rather than falling back to `manager/.env`. The
deploy prints which profile and file it uses. On the server every profile runs the same way: in the
folder its `MANAGER_ROOT` names, on `manager/.env`, as Compose project `manager`.

The deploy sends no other env file. If it finds others in the server's `manager/` folder, such as
`.env.staging` or `.envrc`, it names each one with the command that removes it and leaves them
there for you to remove.

## 3. Add the server to your SSH config

```
Host <control-host>
  HostName <server-address>
  User deploy
  LocalForward 8080 localhost:8080
```

The `LocalForward` line opens the tunnel to the console whenever you `ssh <control-host>`.

## 4. Deploy

From `apps/infra-manager` in your checkout:

```sh
./deploy/deploy.sh --host=<control-host>
```

`--host <control-host>` and the bare `./deploy/deploy.sh <control-host>` work too. The host is
required: there is no default, and a deploy with no host stops before anything leaves your machine.

What it does, in order:

1. Names the build (see [The build it names](#the-build-it-names)).
2. Writes the stack pin, `manager/.stack-commit` (see
   [What a deploy does to the bundled stack](#what-a-deploy-does-to-the-bundled-stack)).
3. Sends the manager's folder to the server with rsync. It leaves out `node_modules`, `.git`,
   build caches, `.scratch/`, `manager/swarm-hls-stream/` and every file whose name starts with
   `.env` except the `.env.sample` files. The env file of step 2 follows on its own. When the
   repository keeps its one lockfile at its root, the deploy cuts the manager's `pnpm-lock.yaml`
   and `pnpm-workspace.yaml` out of it with `tools/app-workspace/cut.mjs` into a temporary folder
   and sends that pair. Your checkout gains no file.
4. Builds the images on the server and runs `manager:upgrade` in a one-off container of the new
   api image (see [The upgrade](#the-upgrade)).
5. Reads the build back from the running api container and fails unless it is the one it built.

The last line it prints names the build:

```text
==> Done: deployed v1.4.0 (635b4e175)
```

### The build it names

Before anything leaves your machine, the deploy names the build with `tools/release/version.mjs` at
the repository root: the tag on the commit you have checked out, or the nearest tag before it and
how far past it (`v1.4.0+3`), or the short commit when no tag is behind it. The name ends in
`-dirty` when the manager's folder, `packages/` or the root's `package.json`, `pnpm-lock.yaml` or
`pnpm-workspace.yaml` holds a change git has not committed. A release tags its commit before it
deploys, as [docs/releasing.md](../../../docs/releasing.md) says.

On a commit without a tag, a deploy run in a terminal asks first:

```text
This commit has no tag.
Run the tag script now? [y/N]
```

`y` runs `node tools/release/tag.mjs`, which tags the commit and pushes the tag, and the deploy
then names the build again. Any other answer deploys the commit under the name it has. Without a
terminal the deploy never asks.

The name and the commit are built into the api image as the build arguments `MANAGER_VERSION` and
`MANAGER_COMMIT` of `manager/docker-compose.yml`. The image keeps them as its environment and as
the labels `org.opencontainers.image.version` and `org.opencontainers.image.revision`, so
`docker image inspect manager-api` on the server names the build too. The name must be 1 to 96
letters, digits and `. _ + / -`, and the commit 40 lowercase hex digits, or the deploy refuses
before sending anything. It also refuses an env file with a `MANAGER_VERSION` or `MANAGER_COMMIT`
line, even an empty one, because Compose would put that value over the image's.

A signed-in console shows the name in its sidebar, under "Streaming Infra" and after the instance
name `MANAGER_INSTANCE_NAME` sets, with the full commit as its tooltip.

### What a deploy does to the bundled stack

The streaming stack the manager ships with is a stack version like any other, called `bundled`
(see [Stack versions](../docs/features/stack-versions.md)). The server fetches and builds it
itself. The only thing about the stack a deploy carries is one commit.

**The pin.** The deploy writes into `manager/.stack-commit` the last commit that changed
`apps/hls-stream`. That commit holds the same stack as the commit being deployed, so a deploy that
changes only the manager finds the bundled build the server already has, builds nothing, and the
bundled version keeps its Tested mark. The server fetches the pin from GitHub, so the deploy refuses
a commit that no remote branch holds: push it first. It also asks GitHub with an anonymous
`git ls-remote` that the repository answers without a login, before anything reaches the server.

**The build.** When the API starts it reads the pin. If the bundled version has no complete build
of that commit, it fetches the commit into `<STACK_VERSIONS_ROOT>/bundled.repo` and builds its
`apps/hls-stream` in a throwaway `node:24-alpine` container, the same way it builds a version you
add on the Versions page. The build log is on the Versions page. A build that fails leaves a failed
version row with the reason, and **Update** on the bundled card runs it again. The API starts
either way.

**Where builds live.** Each published build is one directory that is never written again, at
`<STACK_VERSIONS_ROOT>/bundled.builds/<build id>`. The previous one is kept.

A running container keeps the files it was started with until its own deployment is deployed again.
Updating the manager restarts no stream and moves no deployment onto the new build.

### The upgrade

`manager:upgrade` holds the directory `<STACK_VERSIONS_ROOT>/.manager-upgrade` for its whole run, so
a second deploy started beside it refuses instead of interleaving. Inside it, the command decides
whether Postgres may be started, reads the schema, stops the old API, migrates the database with no
API running, starts the project, waits for the new API to answer `/health`, and then waits for that
API to finish building the pinned stack commit.

`--bundled-timeout` is how long that last wait may take, 1200 seconds unless `BUNDLED_TIMEOUT`
says otherwise. Raise it for a first build on a cold host:

```sh
BUNDLED_TIMEOUT=3600 ./deploy/deploy.sh --host=<control-host>
```

The command prints one line of JSON with the state and the bundled build, which the deploy echoes.
A bundled build that failed or ran out of time makes the deploy exit non-zero after the manager is
already up, so the fix is **Update** on the Versions page rather than another deploy.

## 5. Create the first user

The manager has a login and no sign-up. Once, after the first deploy, create a user on the server:

```sh
ssh <control-host>
cd /opt/streaming/streaming-infra-manager/manager
docker compose exec -it api node dist/cli.js user:add <username>
```

It asks for the password twice with nothing echoed and stores only the hash. Until it has run, the
manager answers 401 to everything but `/health`, and the sign-in page says so.

To feed the password from a program, such as a password manager's command line, pipe it in:

```sh
<command that prints the password> | \
  docker compose exec -T api node dist/cli.js user:add <username> --password-stdin
```

Add every later user from the Access page in the console. Only an admin can add or remove a user,
and nobody can remove themselves, the last user or the last admin.
[Authentication and public access](../docs/features/auth-and-public-access.md) describes the login.

## 6. Open the console

```sh
ssh <control-host>
```

Then open `http://localhost:8080` in your browser. Without the `LocalForward` line, open the tunnel
by hand with `ssh -L 8080:localhost:8080 deploy@<server-address>`.

The sign-in page comes up first. A session ends after twelve hours without activity and fourteen
days after sign-in at most.

## Where the streaming stack's settings live

On the server, in `<STACK_VERSIONS_ROOT>/bundled/`: the stack's base `.env`, `deploy/config.json`
and `engines/<engine>/.env`. They are your files, and no deploy reads or writes them. Editing the
stack's `.env` in your checkout does nothing on the server.

When a stack version adds a setting, it ships it in its `.env.sample`, and the build appends the
sample's line for each missing key to your file, blank where the sample leaves it blank, and logs
the keys it added. Your own lines are never touched.

Edit them from the console: **Settings** on a version card opens every one of those files, with
what the version's own sample says about each key. **Save** commits the whole set as one revision,
and **Save and apply** publishes another build of the same commit carrying it, which new
deployments then run. Redeploy the deployments that should pick it up.

Over SSH, the editing script commits the same revision the page does. Run it with `sudo`, because
the api container runs as root and every file under the versions root is readable by its owner
alone:

```sh
ssh <control-host>
cd /opt/streaming/streaming-infra-manager/manager
sudo scripts/stack-config-edit.sh /opt/streaming/streaming-infra-manager-versions/bundled set .env /tmp/new-env
sudo scripts/stack-config-edit.sh /opt/streaming/streaming-infra-manager-versions/bundled commit
```

The page and the script take the same lock, so neither writes over the other. While the script
holds it the page says so and offers to try again. A lock whose editor is gone comes off with
`sudo scripts/stack-config-edit.sh <root> --unlock`.

## Deploying Bee nodes to other hosts

A deployment's **Host** field is a deploy target: `localhost` or an SSH alias, the name of a `Host`
block in the manager's own `ssh_config`. Only the exact value `localhost` means the manager's own
machine. A host written as `user@host` is refused for a new deployment. The deploy scripts and the
manager reach every other target over SSH, from inside the api container.

That SSH identity lives on the manager's server in `/opt/streaming/manager-ssh/`
(`MANAGER_SSH_DIR`). It holds a deploy key pair, an `ssh_config` and a `known_hosts`:

```sh
# as deploy on <control-host>
mkdir -p /opt/streaming/manager-ssh
ssh-keygen -t ed25519 -N '' -f /opt/streaming/manager-ssh/deploy_key
```

Put the one line of `deploy_key.pub` into the target's `authorized_keys`, as the stage host recipe
in [docs/self-hosting.md](../../../docs/self-hosting.md#a-stage-host) shows.

Write one `Host` block per target in `/opt/streaming/manager-ssh/ssh_config`. `IdentityFile` is the
path inside the container, where the directory is mounted at `/root/.ssh`:

```
Host bee-eu-1
  HostName 203.0.113.7
  User deploy
  IdentityFile /root/.ssh/deploy_key
```

The api image links `/etc/ssh/ssh_config` to the `ssh_config` in that directory, so the aliases
are read as the system-wide config, which SSH accepts from a bind-mounted file it does not own.
`deploy.sh` creates the directory, empty, on every deploy, so a manager that deploys only to itself
needs nothing here.

Put the target's host key in `/opt/streaming/manager-ssh/known_hosts` before the first deploy. The
manager's SSH calls pass `StrictHostKeyChecking=yes` and refuse a host they do not already know:

```sh
ssh-keyscan -H 203.0.113.7 >> /opt/streaming/manager-ssh/known_hosts
```

The manager verifies a target by running `docker info` over that SSH path and recording the
daemon id it reads back, and checks that id again on every deploy, stop, removal and port
observation. So the alias must resolve in `ssh_config`, the key must work without a prompt
(`BatchMode=yes`), and the host key must already be in `known_hosts`.

Links and addresses do not go through SSH. The manager resolves the alias with `ssh -G` against the
same config and puts the result on every deployment as `network_host`, which the console's links
and a pool rung's Bee API address are built from. A browser never sees the alias.

`BEE_DATA_ROOT` describes the manager's host only. A Bee node on another host keeps its data where
the stack puts it on that host, `deploy/data/` under the stack folder the deploy sends there
(`~/swarm-hls-stream-<name>` of the SSH user). The disk figure the manager reports and the cleanup
it runs on removal do not reach that host.

## Opening the manager to the internet

The tunnel costs nothing to keep. Going public is these five steps, in this order. A login on the
manager protects nothing while a Bee node's API is open beside it, because that API asks for no
password and can spend the node's postage and, with a whitelist, its money.

### 1. Prove the login works, over the tunnel

Deploy, create the first user, sign in through the tunnel and click around.

### 2. Check where the node and engine APIs answer

Each deployment publishes the API of every Bee node it runs, on the ports ending in 5 and 7 for
its port slot, and the HTTP ports of its media engine. None of them asks for a password, and Docker
publishes a container port with rules of its own that a host firewall such as ufw never sees. So
the stack's deploy binds each of them to the host's Docker bridge address wherever its `*_BIND`
setting is empty. It reads that address from the Docker daemon of the host that runs the stack, at
every deploy, and uses `127.0.0.1` on Docker Desktop and wherever it cannot read one. Containers on
the host reach the bridge address through `host.docker.internal`, and nothing outside the host
does.

A deployment on another host is one the manager dials over the network, so there the manager
writes `0.0.0.0` into each Bee `*_API_BIND` and `*_API_LISTEN` that nothing names, and that host's
firewall decides who reaches it (step 3).

A client that dials a Bee API on `localhost` or `127.0.0.1` of a Linux host, or by the host's
public or LAN address, does not reach a node bound to the bridge. To keep a node open to such a
client, set its key to `0.0.0.0` in the deployment's own settings.

The settings live in `<STACK_VERSIONS_ROOT>/bundled/.env` on the server, which no deploy reads or
writes. Edit it as under
[Where the streaming stack's settings live](#where-the-streaming-stacks-settings-live). Leave a key
empty for the bridge address, or name one. `<bridge address>` is the gateway that
`docker network inspect bridge` reports on the server:

```env
BEE_UPLOADER_API_BIND=<bridge address>
BEE_GATEWAY_API_BIND=<bridge address>
BEE_RUNG_480P_API_BIND=<bridge address>
BEE_RUNG_720P_API_BIND=<bridge address>
BEE_RUNG_1080P_API_BIND=<bridge address>
SRS_HTTP_API_BIND=<bridge address>
SRS_HTTP_BIND=<bridge address>
OME_HTTP_BIND=<bridge address>
```

`DOCKER_BRIDGE_ADDRESS` in the same file names the address every empty one takes, in place of the
one the deploy reads.

What each one covers:

- `BEE_UPLOADER_API_BIND`, `BEE_GATEWAY_API_BIND`, `BEE_RUNG_480P_API_BIND`,
  `BEE_RUNG_720P_API_BIND` and `BEE_RUNG_1080P_API_BIND` are the Bee HTTP APIs of the deployment's
  own node (the node a pool rung runs), its gateway and the stack's three per-rung nodes. Reaching
  one is enough to spend the node's postage and write feeds with its wallet behind them.
- `SRS_HTTP_API_BIND` is the SRS control API on 1985. It names every live stream, the name an
  ingest URL and a publish key are built from, with every publisher's and viewer's address.
- `SRS_HTTP_BIND` is the SRS file server on 8080 and `OME_HTTP_BIND` is OvenMediaEngine's HLS port
  on 8081. Both serve the finished segments.

Do not use `127.0.0.1` for the Bee ports or for OvenMediaEngine's HLS port on a Linux host, nor any
address the manager's `api` container cannot reach. The manager reaches a local node's API and that
HLS port through `host.docker.internal`, which is the bridge address. An address it cannot reach
stops stamp reads, postage purchases and chequebook transfers for every deployment on the host,
with no message naming the cause, and turns a working engine config rollout into a reported
failure, because the manager probes OvenMediaEngine's HLS port after one. If the address has to be
something other than the bridge, set `BEE_LOCAL_HOST` in the manager's env file to that same
address, written bare as a host name or an IPv4 address. The two SRS ports are the exception: the
manager never reaches them.

`BEE_LOCAL_HOST` is also the address an ABR node pool on this host hands its uploader, in the
`BEE_PUBLISHERS` string. An uploader on another machine is the Bee host's case instead: its rungs
are named at that host's own address, and "A Bee host" in
[docs/self-hosting.md](../../../docs/self-hosting.md) opens their API to the uploader's address
with a wider bind and the `--bee-api-source` flag of step 3.

If this host runs the stack with `COMPOSE_NETWORK=host`, the keys for the Bee APIs are the
`*_API_LISTEN` ones instead: `BEE_UPLOADER_API_LISTEN`, `BEE_GATEWAY_API_LISTEN`,
`BEE_RUNG_480P_API_LISTEN`, `BEE_RUNG_720P_API_LISTEN` and `BEE_RUNG_1080P_API_LISTEN`. Left empty,
the stack's deploy gives each the bridge address. The engines have no such key, so under host
networking they answer on every address.

Commit the edit, **Update** the bundled version on the Versions page so the next build carries it,
then redeploy the deployments that should pick it up. A node or an engine takes its new binding on
its next deploy. The manager copies the base file into each deployment's own `.env.<name>` at every
deploy, with the deployment's own stored settings over it, so a value set once reaches every
deployment that stores no value of its own for that key.

### 3. Generate and review the host firewall

The generator drafts an nftables table from the manager's own record of a host. It needs Node.js,
this checkout, and a fresh inventory export for the target. In the signed-in console, open
`/targets/firewall?alias=localhost` and save the download as `firewall-inventory.json`. For a remote
target, use its verified SSH alias, URL-encoded where needed.

The export is read-only. It checks the daemon identity, the port reservations, the bindings it
observes and the build contracts it retains, and refuses unresolved jobs, unknown owners, an
incomplete inventory and missing build history. Re-export after any deployment, reservation or
network change, because the export describes the moment it was captured.

With the external interface name of the host:

```sh
./deploy/host/firewall-rules.sh --iface <public interface> \
  --inventory firewall-inventory.json --max-slot 20 \
  > /tmp/manager-firewall.nft
less /tmp/manager-firewall.nft
```

The command prints a draft and applies nothing. Run it from this checkout, because the wrapper
needs its sibling Node files and `common/src/portPolicy.js`. Allocation and the generator both
allow at most 100 port slots, and allocation also honours a lower limit of the stack version.

The draft opens four public bands, one per role, each covering 100 slots: the SRT ingest over UDP,
the viewer page, and the two Bee peer ports. The per-rung Bee peer ports of the stack stay closed,
because the manager starts no rung service of the stack's own.

**RTMP.** The draft opens no band for SRS's RTMP port, `10002 + 10 × slot`. To take broadcasts over
RTMP, open that port in the host firewall yourself. RTMP is not encrypted: a broadcaster's stream
key crosses the network as readable text. SRT sends its stream id, key included, before encryption
starts too, so the SRT passphrase keeps the picture private but not the key. SRS plays RTMP back to
its own container only (`SRS_PLAY_FROM` in the stack), because publishing and playback share one
port and a firewall cannot tell them apart.

**A Bee host.** A host whose rungs serve uploaders on other hosts needs one more door, opened only
on request. `--bee-api-source <address>/32`, repeated once per uploader host and once for the
manager's host, opens each slot's Bee API port, `10005 + 10 × slot` over TCP, to those IPv4 blocks
alone, in both the input and the forward chain. A block wider than `/24` is refused. The draft
names the admitted blocks in its header. "A Bee host" in
[docs/self-hosting.md](../../../docs/self-hosting.md) has the matching bind.

A port that one of the bands opens and that some other endpoint already holds makes the generator
refuse, whatever that endpoint's own port variable says. Resolve the conflicting ownership before
you generate another draft. Do not renumber a funded deployment to get past the refusal.

What the table does:

- It replaces only the `inet streaming_infra_manager` table and leaves Docker's chains and other
  applications' tables alone.
- Its input chain defaults to deny and permits SSH, the web edge and the public stack ports.
  `--ssh-port` cannot exempt a port in the protected range 10000 to 19999.
- Its forward chain covers IPv4 and IPv6. On the external interface it permits the public
  translated ports, drops other translated TCP and UDP ports in the protected range, and drops new
  direct routing with no destination translation, which includes direct access to container API
  ports. Review this before using the table on a host that is also a router. Established and
  related connections stay allowed.
- The forward rules match the original destination port after Docker's translation. An accept in
  this table does not override a drop in a later table. The
  [nftables chain documentation](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains)
  explains hook ordering.

Before you apply a draft, validate it with the host's nftables version and review it against the
whole existing ruleset. Keep your SSH session open and confirm a second connection works after
applying it. Persist only the manager's table through the host's firewall configuration, because
replacing all of `/etc/nftables.conf` can discard unrelated policy.

On the manager's own host the Bee APIs sit on the Docker bridge by default. On any other host the
manager binds each Bee API that a deployment leaves empty to `0.0.0.0`, so there this table is what
closes them, and it has to be in place before the first deploy on that host. Host-network
containers whose bindings the manager cannot prove make the export refuse, unless
`KNOWN_HOST_NETWORK_PORTS` names them, as step 4 does for the edge.

### 4. DNS, then the host's edge

The manager has no HTTPS of its own. The host's edge provides it: one Caddy per host, its own
Compose project `edge`, kept in `infra/edge/` at the repository root, serving every console the
host publishes on its loopback under its own name. "Public HTTPS: the host's edge" in
[the admin's deploy guide](../../web2-admin/deploy/README.md) describes it in full.

Point an A record at the server. Give the manager a name of its own rather than an apex domain that
serves other things, because the edge sends an HSTS header that covers subdomains for a year. Then,
from the repository root, put the name in the edge's env file:

```sh
cp infra/edge/.env.sample infra/edge/.env
# set MANAGER_DOMAIN=manager.example.org, and the edge's MANAGER_PORT when
# WEB_PORT in manager/.env is not 8080. The edge's MANAGER_PORT is the
# console's web port, not the api port of the same name in manager/.env.
./infra/edge/edge.sh --host=<control-host>
```

The run says which name it serves on which loopback port, checks that the manager answers there,
and waits for the first certificate. Then open `https://manager.example.org` and sign in. The
certificates live in the edge's volume `edge_caddy-data`, so running the edge again does not ask
Let's Encrypt for another one.

The edge runs on the host's network, and Docker reports no port map for such a container. Until
the manager is told what it holds, every removal on that host refuses with "Container removal or
port release could not be verified", and so do port handovers and the firewall export. Add this
line, with the ports Caddy listens on, to `manager/.env` in your checkout and run
`./deploy/deploy.sh --host=<control-host>` again:

```sh
KNOWN_HOST_NETWORK_PORTS=edge=80/tcp,443/tcp,443/udp
```

Those ports then count as the edge's, so no deployment can reserve them. Name only a reverse proxy
or a similar container whose ports you know. Every host-network container in a named project counts
as holding only the ports listed for it, so list all of them, because a port left out counts as
free. A deployment's Compose project is its name, so no deployment may be called `edge` while the
edge is named here. `manager/.env.sample` has the format.

### 5. Keep the tunnel

`web` still publishes `127.0.0.1:8080`, and the tunnel still reaches it. That is the way back in
when the edge is down, a certificate is stuck or the domain is wrong.

## A deploy that stopped half way

If a deploy failed after the upgrade started, its guard directory is still there:

```sh
ssh <control-host>
cat /opt/streaming/streaming-infra-manager-versions/.manager-upgrade/owner.json
```

`owner.json` names the phase it stopped in: `checking`, `stopping`, `migrating`, `starting`,
`verifying` or `bundled`. The next deploy refuses while the directory exists and prints its path and
phase, because from `stopping` on the API may be down and only a person can tell whether the host
is in a state worth keeping. Look before you remove it:

```sh
cd /opt/streaming/streaming-infra-manager/manager
docker compose ps
docker compose logs --tail 200 api
```

The database is safe to leave as it is. The upgrade publishes nothing itself, and a build the API
had started either finished into its own directory or left a staging directory the next boot
removes. When the host looks sound, remove the guard and deploy again:

```sh
rm -r /opt/streaming/streaming-infra-manager-versions/.manager-upgrade
```

An interrupted build leaves a `tmp-<attempt>` directory under
`<STACK_VERSIONS_ROOT>/bundled.builds/`. The next boot removes it, unless its build container is
still running. Never remove anything else under `bundled.builds/`, where the published builds live.

## Operations

On the server, in `/opt/streaming/streaming-infra-manager/manager`:

```sh
docker compose ps                 # status
docker compose logs -f api        # follow the manager's log
docker compose logs -f web        # follow nginx's log
docker compose restart api        # restart the manager alone
docker compose down               # stop everything, the Postgres volume is kept
docker compose down -v            # also delete the Postgres volume and every record in it
```

A plain `docker compose restart` does not re-read the env file. Deploy again to change a setting.

## How the containers fit

- No service publishes a port to the world. HTTPS is the host's edge, a Compose project of its own
  on the host's network, which proxies the manager's name to `127.0.0.1:8080`.
- `web` (nginx) publishes `127.0.0.1:8080` and nothing else (`WEB_PORT` and `MANAGER_WEB_BIND`
  change it). It serves the built console and forwards `/auth`, `/profiles`, `/groups`, `/health`,
  `/services`, `/config`, `/targets`, `/manager-settings`, `/stages`, `/version`, `/versions`,
  `/chequebook`, `/metrics`, `/events` and `/api/admin-funding` to `api:9876`. Every path the Vite
  dev server proxies must be listed here too, and a unit test compares the two lists.
- `api` publishes no port. The `web` proxy on the internal Compose network is the only thing that
  reaches it.
- `postgres` publishes no port. The api reaches it by service name. A `pnpm dev` on the host gets a
  loopback port from `docker-compose.dev.yml` through `pnpm database:start`, at
  `MANAGER_DEV_PG_PORT`, 5432 unless set.
- The manager's folder (`MANAGER_ROOT`) and the versions root are mounted into the `api` container
  at the same absolute paths they have on the host. The api starts deployments with
  `docker compose` against Compose files in those trees, and the host's daemon resolves their
  relative volumes against the host's filesystem, so the two paths must match.
