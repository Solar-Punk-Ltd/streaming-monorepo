# Server deployment

Single-server deployment: postgres + manager API + nginx-served frontend, all
in one `docker compose` project. Team access over an SSH tunnel, with no public
port, until the host's edge, `infra/edge`, gives it a name and HTTPS. See
"Opening the manager to the internet" below.

## One-time server bootstrap

The examples run as a user named `deploy` and keep the code at
`/opt/streaming/streaming-infra-manager`. Any user in the `docker` group works,
and `MANAGER_ROOT` in `manager/.env` puts the code anywhere else. The data, the
stack versions and the ssh identity default to folders beside it, and
`BEE_DATA_ROOT`, `STACK_VERSIONS_ROOT` and `MANAGER_SSH_DIR` move each of them.

```sh
# As deploy@server
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin rsync
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy /opt/streaming
# log out + back in so the group takes effect

mkdir -p /opt/streaming/streaming-infra-manager/manager
```

Make sure `manager/.env` exists in your local checkout. Every deploy sends it
to the server, so your laptop is the source of truth. Another server gets a
file of its own, as "Which env file a deploy sends" below says. Example:

```env
POSTGRES_PASSWORD=<pick-something>
LOG_LEVEL=info
WEB_PORT=8080
# DATABASE_URL is overridden inside the api container by docker-compose.yml.
# This value is only used if you also run `pnpm dev` on the server (you won't).
DATABASE_URL=postgres://manager:manager@localhost:5432/manager
MANAGER_PORT=9876
```

## Local `~/.ssh/config` snippet

`<control-host>` stands for whatever alias you give the server that runs the manager. The
commands below use the same alias.

```
Host <control-host>
  HostName <server-ip-or-hostname>
  User deploy
  LocalForward 8080 localhost:8080
```

## Deploying

From your local checkout:

```sh
./deploy/deploy.sh --host=<control-host>
```

This rsyncs the repo, then builds the images on the server and runs the upgrade
command that brings the project back up. The rsync leaves out `node_modules`,
`.git`, build caches, `.scratch/`, `manager/swarm-hls-stream/` and every env
file in the tree, every file whose name starts with `.env`, copies such as
`.envrc` or `.env~` included, but the `.env.sample` files, `manager/`'s and the
test fixtures'. Each flag takes its value after `=` or as the next word, so
`--host <control-host>` works too, and so does the host alone,
`./deploy/deploy.sh <control-host>`. With no host at all the deploy goes to the
ssh alias `viewer`.

When the repository keeps its one lockfile at its root, the manager's folder
holds none of its own. The deploy then cuts the manager's `pnpm-lock.yaml` and
`pnpm-workspace.yaml` out of the root's with `tools/app-workspace/cut.mjs`, into
a folder outside the checkout that it removes when it exits, and sends the pair
with the folder. The server's folder holds what its image builds need, and your
checkout gains no file.

### Which env file a deploy sends

One, which the server keeps as `manager/.env`. Without `--profile` it is
`manager/.env`. A server whose settings differ gets a file of its own, made
from the same sample, and `--profile=<name>`, or `--profile <name>`, sends
`manager/.env.<name>` in its place:

```sh
cp manager/.env.sample manager/.env.staging
./deploy/deploy.sh --host=<staging-host> --profile=staging
```

The name follows the manager's rule for a profile name,
`^[a-z0-9][a-z0-9-]{0,30}$`, and `default` means `manager/.env`. `sample` is
not a profile: `manager/.env.sample` is the file every profile is copied from.
A profile needs its host named, because the default target would get its
settings, and a missing file stops the deploy rather than falling back to
`manager/.env`. Every check before anything leaves reads that file, and the
deploy prints which profile and file it uses. A profile changes only which file
is sent. The server runs it as any manager host does: in the folder its
`MANAGER_ROOT` names, on `manager/.env`, as compose project `manager` with the
same volumes.

Each deploy writes that file over the server's, so your checkout is the only
source of truth for it: an edit made on the server is undone by the next
deploy. **The streaming stack's own `.env` is the opposite, and editing it in
your checkout does nothing.** The deploy ships the manager's folder and not
`apps/hls-stream`, and the rsync leaves the server's own
`manager/swarm-hls-stream/`, which existing deployments mount, alone. The
stack's settings live on the server and are edited there, as "Where the
streaming stack's settings live" below describes.

Until 2026-10-06 a deploy sent every file in `manager/` whose name starts with
`.env`, so a server can still hold `manager/.env.staging` and the like, or a
copy such as `.envrc` or `.env~`, beside its own `.env`. Nothing reads them,
but each keeps the settings it was sent with, a database password among them,
and rsync never deletes a file it leaves out. So the deploy names every one of
them but `.env` and `.env.sample` on the server before it builds, with the
command that removes them, and leaves them where they are until you run it:

```sh
ssh <control-host> 'cd /opt/streaming/streaming-infra-manager/manager && rm .env.staging .env.qa .envrc'
```

## What a deploy does to the bundled stack

The streaming stack the manager ships with is a version like any other, called
`bundled`, and the server fetches and builds it there. The only thing about the
stack a deploy carries is one commit.

**Pin.** The deploy writes into `manager/.stack-commit` the last commit that
changed `apps/hls-stream`, the stack this manager bundles. That commit holds the
same stack as the commit being deployed, so a deploy that changes only the manager
finds the bundled build the server already has: it builds nothing and the bundled
version keeps its Tested mark. The server fetches the pin from GitHub, so the deploy
refuses a commit that no remote branch holds: push it first, or `git fetch` when it
was pushed from elsewhere. It also refuses while the monorepo cannot be read
without a login, which it asks with an anonymous `git ls-remote` before anything
reaches the server, because the server fetches that way and would otherwise stop
the old manager and migrate its database before finding out. That file ships with
the repo rsync. Nothing of the stack is installed or built on your machine.

**The first deploy from the monorepo moves the bundled version off `v3.4`.** Until
then the server's bundled version was the stack's release `v3.4`, the last pin of
the manager's own repository. The first deploy from the monorepo pins
`apps/hls-stream` as it is at the deployed commit, which is that release and every
change to the stack since, so that deploy builds the stack once, the bundled
version loses its Tested mark, and the Versions page shows the new commit. A
version added from `v3.4` keeps running it.

**Build, on the server.** When the API starts it reads that pin. If the bundled
version is not already on a complete build of that commit, it fetches the commit
from the monorepo on GitHub into `/opt/streaming/streaming-infra-manager-versions/bundled.repo`
and builds its `apps/hls-stream`
in a throwaway `node:24-alpine` container, exactly as it does for a version you
add in the UI. The build log is on the Versions page. A build that fails leaves
a failed version row with the reason, and Update on the bundled card runs it
again. The API starts either way: a stack that could not be fetched never stops
the manager coming up.

**Upgrade.** The server builds its images, then runs `manager:upgrade` in a
one-off container of the image it has just built. That command creates
`/opt/streaming/streaming-infra-manager-versions/.manager-upgrade` and holds it for the whole
run, so a second deploy started beside this one refuses instead of interleaving
with it. Inside the guard it decides whether Postgres may be started, reads the
schema, stops the old API, migrates the database with no old API running, starts
the project, waits for the new API to answer its health check, and then waits for
that API's own boot to finish building the pinned commit. `--bundled-timeout`
says how long that last wait may take, twenty minutes by default, and you can
raise it for a first build on a cold host with
`BUNDLED_TIMEOUT=3600 ./deploy/deploy.sh --host=<control-host>`. It prints one
line of JSON with the state and the bundled build, which the deploy echoes. A
bundled build that failed or ran out of time makes the deploy exit non zero
after the manager is already up, so the fix is Update on the Versions page
rather than another deploy.

**Where builds live.** Each published build is one immutable directory at
`/opt/streaming/streaming-infra-manager-versions/bundled.builds/<build id>`. Nothing is ever
written into a build again, and the previous one is kept. The tree the engines
mount, `manager/swarm-hls-stream` on the server, is never written over by a
deploy any more.

A running container keeps the files it was started with until its own deployment
is deployed again. Updating the manager does not restart anybody's stream and
does not move a deployment onto the new build.

## Where the streaming stack's settings live

On the server, in `/opt/streaming/streaming-infra-manager-versions/bundled/`: the base `.env`,
`deploy/config.json` and `engines/<engine>/.env`. They are the operator's files
and no deploy reads or writes them.

The first build on a host that was deployed the old way takes them over from
`manager/swarm-hls-stream` on the server, byte for byte, as the first revision.
After that the tree is only ever read, because running engines still mount it.

A version that adds a setting ships it in its `.env.sample`, and the build
completes the host's own file from that sample rather than refusing: the sample's
own line for each missing key is appended, blank where the sample leaves it
blank, and the log names the keys it added. Your own lines are never touched.

Edit them from the manager: **Settings** on a version card opens a page holding
every one of those files, with what the version's own sample says about each key
beside it. **Save** commits the whole set as one revision, and **Save and apply**
publishes another build of the same commit carrying it, which is what new
deployments then run. Redeploy the deployments that should pick it up.

The editing script is still there for work over ssh, and commits the same
revision the page does. Run it with `sudo`: the manager's api container runs as
root, so every file under the versions root belongs to root, and each of them is
readable by its owner alone.

```sh
ssh <control-host>
cd /opt/streaming/streaming-infra-manager/manager
sudo scripts/stack-config-edit.sh /opt/streaming/streaming-infra-manager-versions/bundled set .env /tmp/new-env
sudo scripts/stack-config-edit.sh /opt/streaming/streaming-infra-manager-versions/bundled commit
```

Both take the same lock, so a save from the page and an edit over ssh cannot
write over each other. While the script holds it the page says so and offers
another go, and a lock whose editor is gone comes off with
`sudo scripts/stack-config-edit.sh <root> --unlock`. Update on the Versions
page still works too: it builds the version again and captures whatever
revision is current.

## Deploying Bee nodes to other hosts

A deployment's **Host** field is a deploy target: `localhost`, an ssh alias, or
`user@host`. Only the exact value `localhost` means the manager's own machine:
`deploy.sh` reaches anything that names another host over `ssh`, and so does the
manager, from inside the api container, which has no ssh identity of its own.

That identity lives on the manager host in `/opt/streaming/manager-ssh/`
(`MANAGER_SSH_DIR` in `manager/.env` overrides the path). It holds the deploy
key pair, an `ssh_config` and a `known_hosts`:

```sh
# As deploy@<control-host>
mkdir -p /opt/streaming/manager-ssh
ssh-keygen -t ed25519 -N '' -f /opt/streaming/manager-ssh/deploy_key
ssh-copy-id -i /opt/streaming/manager-ssh/deploy_key.pub deploy@203.0.113.7
```

One `Host` block per target in `/opt/streaming/manager-ssh/ssh_config`. `IdentityFile` is the
path _inside the container_, where the directory is mounted at `/root/.ssh`:

```
Host bee-eu-1
  HostName 203.0.113.7
  User deploy
  IdentityFile /root/.ssh/deploy_key
```

`docker-compose.yml` mounts the directory at `/root/.ssh`, and the api image
links `/etc/ssh/ssh_config` to the `ssh_config` inside it, so the aliases are
read as the system-wide config. That link is what makes the file usable: ssh
refuses a per-user config it does not own, and a bind-mounted file keeps the
host's uid. `deploy.sh` creates the directory on every deploy, empty, as the
user it deploys as, so a manager that deploys only to itself needs nothing here
and the link points at nothing, which ssh treats as no config. Until 2026-09-16
the file itself was bind-mounted too, and a host without it could not start the
upgrade container: Docker made a root-owned directory at the missing path and
refused to mount it onto a file.

Put the target's host key in `/opt/streaming/manager-ssh/known_hosts` before the first
deploy. The manager's own ssh calls pass `StrictHostKeyChecking=yes` on the
command line, which overrides an `accept-new` in the config file and refuses a
host it does not already know:

```sh
ssh-keyscan -H 203.0.113.7 >> /opt/streaming/manager-ssh/known_hosts
```

The manager verifies a target by running `docker info` over that same ssh path
and recording the daemon id it reads back, then re-checks that id on every
deploy, stop, remove and port observation, so the alias must resolve in
`ssh_config`, the key must authenticate without a prompt (`BatchMode=yes`), and
the host key must already be in `known_hosts`.

Links and addresses do not go through ssh at all. The manager resolves the alias
with `ssh -G` against the same config and puts the result on every profile as
`network_host`, which is what the UI's component links and a rung's Bee API
address in `BEE_PUBLISHERS` are built from. A browser never sees `bee-eu-1`.

`BEE_DATA_ROOT` describes the manager's host only. A Bee node on a remote target
keeps its data where the stack's own default puts it on that host,
`deploy/data/` under the rsynced stack directory (`~/swarm-hls-stream-<name>`
of the ssh user), and the manager exports no data directory for such a deploy
at all. Neither the disk figure it reports nor the data-directory cleanup it
runs on removal reaches that host.

## A deploy that stopped half way

If a deploy failed after the upgrade started, the guard directory is still
there:

```sh
ssh <control-host>
ls /opt/streaming/streaming-infra-manager-versions/.manager-upgrade
cat /opt/streaming/streaming-infra-manager-versions/.manager-upgrade/owner.json
```

`owner.json` names the phase it stopped in: `checking`, `stopping`, `migrating`,
`starting`, `verifying` or `bundled`. The next deploy refuses while that
directory exists and prints the path and the phase rather than clearing it,
because from `stopping` onwards the API may be down and only a person can tell
whether the host is in a state worth keeping.

What to look at before removing it:

```sh
cd /opt/streaming/streaming-infra-manager-versions/.manager-upgrade   # read the phase
cd /opt/streaming/streaming-infra-manager/manager
docker compose ps                 # is the api up, is postgres healthy
docker compose logs --tail 200 api
```

The database is safe to leave as it is. The upgrade publishes nothing itself,
and a build the API had started either finished into its own immutable directory
or left a staging directory the next boot removes.

When the host looks sound, remove the directory by hand and deploy again:

```sh
rm -r /opt/streaming/streaming-infra-manager-versions/.manager-upgrade
```

### What a stopped deploy leaves behind

Nothing that has to be cleaned by hand. A deploy ships no package of the
streaming stack any more, so there is no `bundled.packages/` directory to sweep
and no copy of anybody's secrets waiting in one. A host that was deployed the old
way may still have that directory from before this change: nothing reads it now,
and it holds the `.env`, `deploy/config.json` and engine envs of every deploy
that shipped one, so remove it once no deploy is running.

```sh
ssh <control-host>
ls /opt/streaming/streaming-infra-manager-versions/bundled.packages    # if it is still there
rm -r /opt/streaming/streaming-infra-manager-versions/bundled.packages
```

What a build that was interrupted leaves is a `tmp-<attempt>` directory under
`/opt/streaming/streaming-infra-manager-versions/bundled.builds/`. The next boot removes it,
unless its build container is still running, and never removes a published build.
Never remove anything else under `bundled.builds/`, which is where the published
builds live.

## The first user

The manager has a login, and there is no sign-up. Once, after the first deploy,
create a user on the server:

```sh
ssh <control-host>
cd /opt/streaming/streaming-infra-manager/manager
docker compose exec -it api node dist/cli.js user:add <username>
```

It asks for the password twice with nothing echoed and writes only the hash.
Until it has been run, the manager answers 401 to everything but its health
check, and the sign-in page says so.

To feed the password from a vault instead of typing it:

```sh
op read "op://<vault>/<item>/password" | \
  docker compose exec -T api node dist/cli.js user:add <username> --password-stdin
```

Every later user is added from the Access page in the UI. Only an admin can
add or remove a user, and nobody can remove themselves, the last user or the
last admin.

## Accessing

```sh
ssh <control-host>       # the LocalForward in ssh_config opens the tunnel
# then in your browser:
open http://localhost:8080
```

The sign-in page comes up first. A session lasts twelve hours of inactivity and
fourteen days at most.

If you skip the ssh_config entry: `ssh -L 8080:localhost:8080 deploy@<server>`.

## Opening the manager to the internet

The tunnel is the default and costs nothing to keep. Going public is these five
steps, in this order. The order is the point: a login on the manager protects
nothing while a Bee node's API sits open beside it, because that API needs no
password and can spend the node's postage and, with a whitelist, its money.

### 1. Prove the login works, over the tunnel

Deploy as above, create the first user with the CLI, sign in through the tunnel
and click around. Nothing below is worth doing until the gate is real.

### 2. Check where the node and engine APIs answer

Each deployment publishes the API of every Bee node it runs, on the ports
ending 5 and 7 for its slot, and the three HTTP ports its engines serve. None
of them asks for a password, and Docker publishes a container port with rules
of its own that a host firewall such as ufw never sees. So the stack's own
deploy binds each of them to the host's Docker bridge address wherever its
`*_BIND` setting is empty. It reads that address from the Docker daemon of the
host that runs the stack, at every deploy, over ssh for another host, and it is
`127.0.0.1` on Docker Desktop and wherever it could not be read. Containers on
the host reach the bridge address through `host.docker.internal`, and nothing
outside the host does. Which other ports are reachable is your firewall's job,
step 3.

A deployment on another host is one the manager dials over the network, so for
such a deployment the manager writes `0.0.0.0` into each Bee `*_API_BIND` and
`*_API_LISTEN` that nothing names, and that host's firewall decides who reaches
it.

Anything that dials a Bee API on `localhost` or `127.0.0.1` on a Linux host,
or by the host's public or LAN address, does not reach a node bound to the
bridge. The stack's `health.sh` asks each one where it is bound. To keep a node
open to such a client, set its key to `0.0.0.0` in the deployment's own
settings, which the deploy leaves standing. There is one key per Bee node of
the stack: `BEE_UPLOADER_API_BIND` for the deployment's own node, which is the
node a pool rung runs, `BEE_GATEWAY_API_BIND` for its gateway, and
`BEE_RUNG_480P_API_BIND`, `BEE_RUNG_720P_API_BIND` and `BEE_RUNG_1080P_API_BIND`
for the stack's own per-rung nodes.

The eight settings live on the server, in
`/opt/streaming/streaming-infra-manager-versions/bundled/.env`, and no deploy
reads or writes that file. Edit it there with the editing script, as under
"Where the streaming stack's settings live" above. Leave them empty for the
bridge address, or name one, where `<bridge address>` is the address
`docker network inspect bridge` reports as the gateway on the server:

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

`DOCKER_BRIDGE_ADDRESS` in the same file names the address every empty one of
them takes, in place of the one the deploy reads.

What each one covers:

- **`BEE_UPLOADER_API_BIND`**, **`BEE_GATEWAY_API_BIND`**,
  **`BEE_RUNG_480P_API_BIND`**, **`BEE_RUNG_720P_API_BIND`** and
  **`BEE_RUNG_1080P_API_BIND`** are the Bee HTTP APIs of the deployment's own
  node, its gateway and the stack's three per-rung nodes, and none asks for a
  password, so reaching one is enough to spend the node's postage, upload chunks
  and write feeds with its wallet behind them.
- **`SRS_HTTP_API_BIND`** is the SRS control API on 1985, which asks for no
  password either and will name every live stream, the same name an ingest URL
  and a publish key are built from, along with every publisher's and every
  viewer's address.
- **`SRS_HTTP_BIND`** is the SRS file server on 8080 and **`OME_HTTP_BIND`** is
  OME's HLS port on 8081, and both serve the finished segments.

Not `127.0.0.1` for the Bee ports or for OME's HLS port on a Linux host, and not
any other address the manager's `api` container cannot reach. The manager
reaches a local node's API and that HLS port through `host.docker.internal`,
which is the bridge address, so loopback would cut off stamp management, and
any address the container has no route to does the same without saying so:
stamp reads, postage buys and chequebook operations stop for every deployment
on this host and no message names the cause. If the address has to be
something other than the bridge, set `BEE_LOCAL_HOST` in `manager/.env` to that
same address, written bare as a host name or an IPv4 address: no scheme, no
port, no path. A value of any other shape, an IPv6 address included for now,
stops the manager at startup with the variable named. The two SRS ports are the
exception: the manager never reaches them.

OME's port is worth one more line. After an engine config rollout the manager
probes it on that same address to see whether OME came back up, so a binding it
cannot reach turns a rollout that worked into a reported failure.

An ABR node pool is worth one more again, because this address leaves the
manager inside its pool string. The `BEE_PUBLISHERS` value a pool hands an
uploader names every rung at this same bridge address, not at the host's public
one, and that is what an uploader container on this host can reach.
`BEE_LOCAL_HOST` overrides that too. An uploader on another machine is the Bee
host's case instead: its rungs are named at that host's own address, and "A Bee
host" in `docs/self-hosting.md` at the repository root opens their API to the
uploader's address with a wider bind and the `--bee-api-source` flag of step 3.

If this host runs the stack with `COMPOSE_NETWORK=host`, the keys that apply to
the Bee APIs are the `*_API_LISTEN` ones instead, `BEE_UPLOADER_API_LISTEN` and
`BEE_GATEWAY_API_LISTEN`, with `BEE_RUNG_480P_API_LISTEN`,
`BEE_RUNG_720P_API_LISTEN` and `BEE_RUNG_1080P_API_LISTEN` for the stack's own
per-rung nodes, and `*_API_BIND` does nothing there at all. Left empty, the
stack's deploy gives each the bridge address, and points the uploader at it.
The engines have no such key, and their three settings do nothing under host
networking either, so there they answer on every address.

Commit the edit, Update the bundled version from the Versions page so the next
build captures it, then redeploy the deployments that should pick it up. A node
or an engine takes its new binding on its next deploy and not before. The
manager copies that base file fresh into each deployment's own `.env.<name>`
every time it deploys, with the deployment's own stored settings over it, so a
value set once reaches every deployment that stores no value of its own for
that key.

### 3. Generate and review the host firewall

The generator requires Node.js, this checkout's shared port policy, and a fresh
inventory export for the target. In the signed-in manager browser, open
`/targets/firewall?alias=localhost` and save the download as
`firewall-inventory.json`. Use the verified SSH alias instead of `localhost`
for a remote target, URL-encoding the alias when needed.

The export is read-only. It checks daemon identity, reservations, observed
bindings and retained immutable build contracts. It refuses unresolved jobs,
unknown owners, incomplete inventory and mutable or missing build history.
A published version is only a candidate. A retained service snapshot must be
covered by its own build contract.

With the external interface name supplied by the host operator:

```sh
./deploy/host/firewall-rules.sh --iface <public interface> \
  --inventory firewall-inventory.json --max-slot 20 \
  > /tmp/manager-firewall.nft
less /tmp/manager-firewall.nft
```

The command prints a draft and applies nothing. Run it from this checkout.
The shell wrapper needs its sibling Node files and `common/src/portPolicy.js`.

Both new allocation and the generator use a maximum of 100 slots. Allocation
also honors a lower stack limit. Existing deployments keep their slots and
reservations.

Four public bands are opened, one per role: the SRT ingest on UDP, the viewer
page, and the two Bee peer ports. Each covers 100 slots. The three per-rung Bee
peer ports were bands here until 2026-09-16 and are not any more, because this
manager starts no rung service, so 297 ports that never carried a listener are
now closed like any other private port. The slot algebra still reserves them,
which costs nothing and keeps the numbering free for a version that does run
them.

**RTMP.** This draft opens no band for SRS's RTMP port, `10002 + 10 × slot`,
so it drops that port like any other private one. That is the draft's choice
and nothing more: the consoles offer RTMP on every SRS stage, because which
ports are reachable is the firewall's job, and an operator who wants
broadcasters on RTMP opens the port in the host firewall. SRS allows play from
its own container only, `SRS_PLAY_FROM` in the stack, because RTMP publishing
and playback share one port and a firewall cannot tell them apart.

RTMP is not encrypted. A broadcaster's stream key crosses the network as
readable text, and a key read off the network publishes over RTMP, whichever
protocol it was read from, because SRT sends its stream id, key included,
before encryption starts. With the takeover on, which the stack sets wherever
keys are checked, such a publisher can also replace a live broadcast. The SRT
passphrase keeps the picture private but not the key.

A Bee host whose rungs serve uploaders on other hosts needs one more door, and
it is opened only on request. `--bee-api-source <address>/32`, repeated once
per uploader host and once for the manager's host, opens each slot's Bee API
port, `10005 + 10 × slot` over TCP, to those IPv4 blocks and to nobody else, in
both the input and the forward chain. A block wider than `/24` is refused,
because anyone inside it can spend the node's postage. Without the flag nothing about the draft changes and the API
ports stay closed. The draft names the admitted blocks in its header. Such a
host binds its rungs' API wider as well, and "A Bee host" in
`docs/self-hosting.md` has both halves.

An endpoint that lands on a tuple one of those bands opens causes generation to
refuse, whatever its own port variable is. It is not treated as a closed port
merely because `--max-slot` is at most 100. Fix the conflicting ownership
through the reviewed remediation process before generating another candidate.
Do not renumber a funded deployment to bypass this refusal.

The candidate replaces only the `inet streaming_infra_manager` table. It
does not clear Docker's chains or another application's tables. Its input
chain defaults to deny and permits SSH, the web edge and the supported public
stack ports. `--ssh-port` cannot exempt a port within the protected
10000 to 19999 range.

Its forward chain covers IPv4 and IPv6. On the selected external interface,
it permits supported translated public ports and drops other translated
TCP/UDP ports in the protected range. It also drops new direct routing that
has no destination translation, including direct access to container API
ports. **Review this restriction before using the candidate on a host that
also serves as a router.** Forwarding arriving on other interfaces and
unrelated translated ports outside the protected range are left to the
host's other policies. Established and related connections remain eligible.

The forward rules match the original destination port after Docker's
translation. An accept in this table does not override a later table's drop.
See the [nftables chain documentation](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains)
for hook ordering and verdict behavior.

The export records a capture time and database fingerprint. It is evidence
from that capture, not proof that the host has remained unchanged or that a
hand-edited file is trustworthy. Re-export after deployment, reservation or
network changes. Read-only capture cannot freeze external host changes.

Before applying a reviewed file, the operator must validate it with the
host's nftables version and review coexistence with the complete existing
ruleset. Keep the SSH session open and verify a second connection after any
operator-approved application. Persist only the manager table through the
host's existing firewall configuration. Replacing all of `/etc/nftables.conf`
could discard unrelated policy.

The Bee API bind of step 2 keeps those APIs on the Docker bridge by default
only on the manager's own host. On any other host the manager binds each Bee
API that a deployment's settings leave empty to `0.0.0.0`, so there this
table is what closes them, and it has to be in place before the first deploy
on that host. On a Bee host it admits the addresses named with
`--bee-api-source` alone. The input hook covers host listeners. The forward hook covers
published container traffic. Host-network containers with unprovable bindings
cause the inventory export to refuse, unless `KNOWN_HOST_NETWORK_PORTS` names
them, as step 4 does for the edge.

### 4. DNS, then the host's edge

The manager has no HTTPS of its own. The host's edge does it: one Caddy per
host, its own compose project `edge`, kept in `infra/edge/` in this repository,
serving every console the host publishes on its loopback under its own name. On
a host that runs the manager alone it serves the manager's name alone. "Public
HTTPS: the host's edge" in
[../../web2-admin/deploy/README.md](../../web2-admin/deploy/README.md) is the
whole of it.

Point an A record at the server. Give the manager a name of its own rather than
an apex domain that also serves other things, because the edge sends an HSTS
header that covers subdomains for a year. Then, from the repository root, put
the name in the edge's env file:

```sh
cp infra/edge/.env.sample infra/edge/.env
# set MANAGER_DOMAIN=manager.example.org, and MANAGER_PORT if WEB_PORT is not 8080
./infra/edge/edge.sh --host=<control-host>
```

The run says which name it serves on which loopback port, checks that the
manager answers there, and waits a while for the first certificate. Then open
`https://manager.example.org` and sign in. The certificates live in the edge's
volume `edge_caddy-data`, so running the edge again does not ask Let's Encrypt
for another one.

The edge runs on the host's network, and Docker reports no port map for such a
container. Until the manager is told what it holds, every removal on that host
refuses with "Container removal or port release could not be verified", and so
do port handovers and the firewall export of step 3. Name it in the manager's
env file with the ports Caddy listens on, then restart the manager:

```sh
KNOWN_HOST_NETWORK_PORTS=edge=80/tcp,443/tcp,443/udp
```

Those ports then count as the edge's bindings, so a deployment still cannot
reserve them. Name only a reverse proxy or a similar container whose ports you
know. The trust is per compose project: every host-network container in a named
project counts as holding only the ports listed for it. So list every port
those containers hold, because a port left out counts as free and can be handed
to a deployment. A deployment's compose project is its name, so no deployment
may be called `edge` while the edge is named here. Creating one is refused, and
an existing one stops the manager at startup. Any host-network container the
setting does not name still blocks, and a malformed value stops the manager at
startup. `manager/.env.sample` has the format.

### 5. Keep the tunnel

`web` still publishes `127.0.0.1:8080`, and the tunnel still reaches it. That is
the way back in when the edge is down, the certificate is stuck or the domain is
wrong, so leave it there.

## Operations

All run on the server (`ssh <control-host>`, then `cd /opt/streaming/streaming-infra-manager/manager`):

```sh
docker compose ps                 # status
docker compose logs -f api        # tail manager logs
docker compose logs -f web        # tail nginx logs
docker compose restart api        # restart just the manager
docker compose down               # stop everything (postgres volume kept)
docker compose down -v            # nuke postgres data too, so be sure
```

## Architecture notes

- **No service publishes a port to the world.** HTTPS is the host's edge,
  `infra/edge`, a compose project of its own on the host's network, which
  terminates TLS and proxies the manager's name to `127.0.0.1:8080`.
- **`web`** (nginx:alpine) publishes `127.0.0.1:8080` and nothing else, so it is
  reachable through the SSH tunnel and from the host's edge on the host's
  loopback, never directly from outside. It serves the built React SPA and
  reverse-proxies `/auth`, `/profiles`, `/groups`, `/health`, `/services`,
  `/config`, `/targets`, `/manager-settings`, `/versions`, `/chequebook`,
  `/metrics` and `/events` to `api:9876`. Every path the dev server proxies has
  to appear here too. A path wired in one place and not the other is how the
  whole transfer history had no route in production until 2026-09-11, and a
  test checks the two lists against each other.
- **`api`** has no published port at all. The `web` proxy on the internal
  compose network is the only thing that reaches it.
- **`postgres`** has no published port. The api reaches it by service name,
  and a host-side `pnpm dev` gets a loopback port from `docker-compose.dev.yml`
  through `pnpm database:start`, at `MANAGER_DEV_PG_PORT` (5432 unless set).
- The whole repo is bind-mounted into the `api` container at the same
  absolute path it has on the host (`/opt/streaming/streaming-infra-manager`).
  This is so compose files under `manager/swarm-hls-stream/` resolve volume
  paths consistently when their `docker compose up` is forwarded to the host
  daemon via the mounted socket.
