# Running your own deployment

This guide takes you from empty machines to a live stream you run yourself: what hardware to rent,
what to install, how to run the deploy scripts in this repository, how to fund and stamp your own
Bee nodes, and how to keep the dangerous ports closed. Read
[architecture/overview.md](architecture/overview.md) first for what each part is.

Everything here uses placeholders. `203.0.113.6`, `203.0.113.7` and `203.0.113.8` are documentation
addresses for a control host, a stage host and a Bee host, `manager.example.org` and
`admin.example.org` are the two console names, and `deploy` is the account the scripts log in as.
Put your own in their place. Any Linux machine with Docker that you can reach over ssh works, from
any provider or your own hardware.

## Hardware, in general terms

One machine can carry all three roles for a first try. Split them once you broadcast for real.

- **Control host**: small. Two cores, 4 GB of memory and 40 GB of disk run the manager, the web2
  admin, their databases and the edge. The first manager deploy builds the stack there, which is
  the only time it is busy.
- **Stage host**: sized by the ingest. A single rendition needs little. A four-rung ABR ladder
  transcodes every rung on the CPU, so give it eight or more modern cores per concurrent ladder
  broadcast, and 50 GB or more of disk for Docker builds and the media volume.
- **Bee host**: sized by the number of Bee nodes. Plan on one core, 2 GB of memory and a few tens of
  GB of disk per node, and a network link that is not metered per gigabyte, because a Bee node talks
  to many peers all the time.

Put the stage host and the Bee host close to each other on the network. The uploader writes every
segment through a rung's Bee API, so their round trip is paid on every segment.

## What every host needs

Docker with Compose v2, rsync and curl, on a Debian or Ubuntu host, and an account in the `docker`
group that you can log in to over ssh with a key. The deploy scripts keep their files under
`/opt/streaming` unless you tell them otherwise.

```sh
sudo apt-get update
```

```sh
sudo apt-get install -y docker.io docker-compose-v2 rsync curl
```

```sh
sudo useradd --create-home --shell /bin/bash deploy
```

```sh
sudo usermod -aG docker deploy
```

```sh
sudo install -d -o deploy -g deploy /opt/streaming
```

It worked when `ssh deploy@203.0.113.6 docker ps` from your machine prints an empty table. Ubuntu's
own archive names the Compose plugin `docker-compose-v2` and Docker's apt repository names it
`docker-compose-plugin`, so install whichever your sources offer.

## The control host

The control host runs the manager, the web2 admin and the edge. Each is brought up by its own script,
run from a checkout of this repository on your own machine, in this order: the manager first,
because it puts the stack and the Bee nodes on the other hosts, then the admin, which needs no
stage, no Bee node and no batch to start, and the edge last, because it checks that each console
answers before it serves it. The stages come after, from the manager, and each registers itself
with the admin. [architecture/stages.md](architecture/stages.md) is the design.

1. **An ssh alias on your machine**, in `~/.ssh/config`. The forward is the way into the manager
   before the edge serves it, and stays the way in when the edge is down.
   `<control-host>` stands for whatever alias you choose, and the steps below use it.

   ```
   Host <control-host>
     HostName 203.0.113.6
     User deploy
     LocalForward 8080 localhost:8080
   ```

2. **The firewall.** Tcp 22 from your own address, and tcp 80 and 443 from anywhere, because Let's
   Encrypt checks the names from addresses it does not publish. Add udp 443 for HTTP/3 if you want
   it. Nothing else: both consoles listen on the host's loopback only.

3. **The manager.** From `apps/infra-manager` on your machine, make `manager/.env` from the sample
   and set at least `POSTGRES_PASSWORD`. The file travels with every deploy, so your checkout is its
   source. Set `MANAGER_ROOT` there if the manager should live anywhere but
   `/opt/streaming/streaming-infra-manager`.

   ```sh
   cp manager/.env.sample manager/.env
   ```

   ```sh
   ./deploy/deploy.sh <control-host>
   ```

   It worked when the deploy ends without an error and `http://localhost:8080` shows the manager's
   sign-in page while `ssh <control-host>` is open. The first deploy takes a while, because the host
   builds the stack version the manager bundles.

   Every Bee API and engine HTTP port the stack runs answers on the host's Docker bridge address
   wherever its own `*_BIND` setting is empty, because the API asks for no password and Docker
   publishes past a host firewall. The stack's deploy reads that address at deploy time. Under
   `COMPOSE_NETWORK=host` the Bee APIs listen there through `*_API_LISTEN` instead. "Check where the
   node and engine APIs answer" in `apps/infra-manager/deploy/README.md` names the settings. A
   client that dials a Bee API by `localhost`, `127.0.0.1` or the host's public or LAN address does
   not reach a node on the bridge. To keep a node open to such a client, give the deployment
   `0.0.0.0` in its own settings for that node's key, `BEE_UPLOADER_API_BIND`,
   `BEE_GATEWAY_API_BIND`, `BEE_RUNG_480P_API_BIND`, `BEE_RUNG_720P_API_BIND` or
   `BEE_RUNG_1080P_API_BIND`, and let the firewall decide who reaches it.

4. **The manager's first user**, on the host. It asks for the password twice.

   ```sh
   cd /opt/streaming/streaming-infra-manager/manager && docker compose exec -it api node dist/cli.js user:add <username>
   ```

5. **The manager's deploy key**, which it logs in to the stage and Bee hosts with. It lives on the
   host in `/opt/streaming/manager-ssh/`, as a key pair named `deploy_key` beside an `ssh_config` and
   a `known_hosts`. "Deploying Bee nodes to other hosts" in `apps/infra-manager/deploy/README.md`
   shows how to make it. The one line of `deploy_key.pub` is what the stage and Bee hosts authorize.

6. **The web2 admin.** From `apps/web2-admin`, make the profile's env file from the sample and fill
   in what it asks for: `POSTGRES_PASSWORD`, `FEED_PRIVATE_KEY`, the brand key the catalog is
   signed with, and `INTERNAL_API_TOKEN`, the registrar token the manager pushes with. Generate
   your own key and token. The sample's values are public and the deploy script refuses them,
   unless `--allow-sample-secrets` is given for a test install. The admin takes no stage settings:
   no ingest address, port or passphrase, no Bee node and no batch. It learns each stage from the
   manager and writes the catalogue through the catalogue node the manager designates, refusing to
   publish, saying why, until the manager has. The `INGEST_*` keys, `BEE_URL` and
   `POSTAGE_BATCH_ID` an older env file carries are no longer read, and the deploy names each one
   it finds.

   ```sh
   cp backend/.env.sample backend/.env.brand-a
   ```

   ```sh
   ./deploy/deploy.sh --host=<control-host> --profile=brand-a
   ```

   It worked when the deploy reports the API and the console healthy and prints the console's
   loopback port, 9090 unless a port slot says otherwise, and the command that makes the admin's
   first user. Run that command once. `--remote-path` puts the checkout somewhere other than
   `/opt/streaming/streaming-monorepo`.

7. **The edge.** Point an A record for each name at the host first. A name that does not resolve
   turns every certificate attempt into a failure, and Let's Encrypt limits those. Then, from the
   repository root, make the edge's env file and set `MANAGER_DOMAIN` and `ADMIN_DOMAIN`:

   ```sh
   cp infra/edge/.env.sample infra/edge/.env
   ```

   ```sh
   ./infra/edge/edge.sh --host=<control-host>
   ```

   It worked when `https://manager.example.org` and `https://admin.example.org` show the two sign-in
   pages. A host that runs the manager alone leaves `ADMIN_DOMAIN` empty.

8. **The admin link.** In the manager, **Manager settings**, the card **Web2 admin link for new
   deployments**: the address `https://admin.example.org` and the admin's `INTERNAL_API_TOKEN`,
   then **Test connection** and **Save**. The test proves the token on the admin's registrar check.
   It worked when it says "The web2 admin answered and took the token." The manager pushes every
   stage and the catalogue stamp with this token, and gives it to no uploader. The address is the
   edge's https one: every push carries this token and each stage's SRT passphrase and token hash,
   and the manager refuses a plain http address to another host than its own unless its
   `ADMIN_LINK_ALLOW_PLAIN_HTTP=true` is set, for a test setup.
   `apps/infra-manager/docs/features/web2-admin-link.md` has the details.

9. **The Bee host and the catalogue node**, by the Bee host recipe below: the ABR node pool, and a
   Bee-only deployment of its own for the catalogue, both funded from outside with an immutable
   batch bought on the catalogue node. Then, on **Manager settings**, designate that node and its
   batch as the brand's catalogue node. The manager pushes it to the admin, whose Stages page then
   shows the catalogue batch. The Bee host's firewall admits the control host to that node's API.

10. **The stage**, by the stage host recipe below: an **ABR Uploader** deployment with the pool's
    string and a stream key of its own, which the wizard generates. Its Web2 admin group starts on,
    from the manager's link, with **A token of its own**. The first deploy generates that token and
    registers the stage with the admin before the uploader starts. It worked when the admin's
    **Stages** page lists the stage, ready, with "Its own token".

11. **The viewer and the first stream.** Build a viewer for the brand's catalog owner and topic,
    the address and topic the admin's `/api/config` names, and put its address in the admin's
    `VIEWER_BASE_URL`. Then in the admin, **My Streams**: create a stream, pick its stage, schedule
    and publish. The OBS panel shows that stage's ingest details.

**Upgrading a host that runs the admin and manager from before stages.** A fresh installation
needs none of this. On a running one, in this order:

0. **Create the catalogue node**, by step 6 of the Bee host recipe below: a Bee-only deployment,
   funded, with one immutable batch of depth 18 or more bought on it. It must be ready before step 2.
1. **Deploy the manager that pushes stage records**, and designate the catalogue node and its batch
   on **Manager settings** at once. The admin from before stages has no `/api/internal/stages` or
   `/api/internal/catalogue-stamp` route, so every stage's push and the catalogue stamp come to
   `not-admin` ("not a web2 admin") until step 2. That is harmless: that admin stores nothing and
   keeps writing with its env file's batch, and Test connection on Manager settings still takes the
   token there. Create no stage and rotate nothing until step 2 is done: an admin from before stages
   refuses a token of its own.
2. **Deploy the intermediate admin**, which takes stage records and still accepts the shared
   token on an uploader's routes: commit `d29616851` of `feat/stages` (tag it
   `web2-admin/stages-intermediate` before `feat/stages` is merged to `main`, because a squash or
   rebase merge leaves that commit unreachable). It takes both the shared token and a stage's own.
   It refuses every catalogue write, `503`, until it holds a catalogue stamp, so publishing and the
   uploaders' state reports (which retry) wait from its start until the manager's next push, at
   most ten seconds after it answers. Note the env file's `POSTAGE_BATCH_ID` and `BEE_URL` before
   they go: the batch is needed, below.
3. **Before any rotation, give every stream a stage.** Unpublish every scheduled stream, pick its
   stage and publish it again, and pick a stage for every draft. A stage on a token of its own is
   answered only about its own streams, so a stream with no stage is reached by no uploader once
   its stage is rotated. A stream live at rotation keeps its live state on the catalogue until an
   operator unpublishes it.
4. **Rotate and redeploy every stage** (**Rotate the uploader's admin token** on its deployment
   page, then deploy) until the admin's Stages page reads "Its own token" for all of them.
5. **Deploy the admin that refuses the shared token.**

Skipping steps 2 to 4 means every running uploader gets 401 from the admin that refuses the shared
token until its stage is rotated and redeployed. A fresh installation needs none of this: every stage it creates has a
token of its own from its first deploy.

After the upgrade, give each stage a `STREAM_KEY` of its own in the manager and redeploy it right
after. A stage from before stages signs with the brand key, which its `STREAM_KEY` had to equal, so
until then a compromised stage host leaks the brand key. A scheduled stream keeps the owner it was
published with and is refused at the gate until it is unpublished and published again; a recording
keeps the key it was made under.

**Until the catalogue is moved, keep the batch from before stages.** On an upgraded host every
catalogue slot written before step 2 is stamped by the env file's `POSTAGE_BATCH_ID` batch, which
the admin records as `batch_id NULL`, and the viewer stops at the first slot it cannot find. Until
the move has been tried on a real node
([architecture/stages.md](architecture/stages.md#trying-the-move-on-a-real-node)) and run here:
keep that batch topped up and its node running; never dilute it, replace it or name it in a pool
string, since the manager does not know it and guards only the catalogue node's batches; and run
the move as the first thing after the trial. This is the one remaining way the catalogue can go
dark.

[architecture/stages.md](architecture/stages.md) has the reasons.

## A stage host

A stage host carries stack deployments: the ingest engine, the uploader, the viewer and a gateway
node, one deployment per profile and port slot. The manager sends each one over ssh and builds its
images on the host itself.

1. **What every host needs**, above, with this host's address.

2. **The manager's deploy key**, in the account's `authorized_keys`:

   ```sh
   sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
   ```

   ```sh
   echo '<the line from deploy_key.pub>' | sudo tee -a /home/deploy/.ssh/authorized_keys
   ```

   ```sh
   sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys && sudo chmod 600 /home/deploy/.ssh/authorized_keys
   ```

3. **Let only the control host in on ssh**, and your own address while you set up. The public ports
   come in step 7, once the manager knows what it put here.

4. **Tell the control host about this host.** On the control host, add a block to
   `/opt/streaming/manager-ssh/ssh_config`. `IdentityFile` is the path inside the manager's
   container, where that folder is mounted at `/root/.ssh`. The alias must have no dot in it.

   ```
   Host stage-1
     HostName 203.0.113.7
     User deploy
     IdentityFile /root/.ssh/deploy_key
   ```

   Then record the host key, because the manager refuses a host it does not already know:

   ```sh
   ssh-keyscan -H 203.0.113.7 >> /opt/streaming/manager-ssh/known_hosts
   ```

5. **Verify it in the manager.** Open **Host**, enter `stage-1` under **Deploy targets** and press
   **Verify target**. It worked when the target shows `Verified` with a Docker daemon id.

6. **Open the public ports**, and only those, before the first deploy: SRT ingest, the viewer page
   and the two Bee peer ports of each slot. On any host other than the control host the manager
   binds each Bee API that a deployment's settings leave empty to `0.0.0.0`, so the node APIs answer
   on every address from the first deploy, and Docker publishes them past a host firewall such as
   ufw. "Opening the manager to the internet" in `apps/infra-manager/deploy/README.md` says where the
   node and engine APIs answer and generates an nftables table for exactly this, which also filters
   Docker's published traffic. Apply it, or a provider firewall that does the same, before step 7.
   To keep a deployment's Bee APIs on one private address instead, set `BEE_UPLOADER_API_BIND` and
   `BEE_GATEWAY_API_BIND` to that address in its settings.

   The generated table drops the RTMP port, the one ending in 2, like any other private port. Both
   consoles offer RTMP on every SRS stage all the same, because which ports are reachable is the
   firewall's job: open that port in the table if broadcasters are to use RTMP. SRS allows play
   from its own container only, so an open RTMP port takes publishes and refuses playback.

   RTMP is not encrypted. A broadcaster's stream key crosses the network as readable text, and a
   key read off the network publishes over RTMP whichever protocol it was read from, because SRT
   sends its stream id, key included, before encryption starts. With the takeover on, such a
   publisher can also replace a live broadcast. The SRT passphrase keeps the picture private but
   not the key.

7. **Deploy onto it.** **New deployment**, with `stage-1` as the host. The deployment's port slot
   decides its ports, as [architecture/overview.md](architecture/overview.md#ports) lists. It worked
   when an encoder reaches the SRT port, a browser opens the viewer page, and a port ending in 5 or 7
   does not answer from outside.

The engine's `docker logs` on a stage host are as sensitive as its env files. SRS logs every
broadcaster's publish key when they connect and the webhook token on every hook it calls, and a
publish the uploader refuses logs both at error, whatever the level. The detail, and why the
level stays at trace, is in `apps/hls-stream/engines/README.md`, "What SRS logs".

## A Bee host

A Bee host carries the Bee nodes of ABR node pools, one node per quality rung, which the uploaders on
stage hosts publish through. It is prepared like a stage host.

1. **Steps 1 to 5 of the stage host**, with this host's address and an alias such as `bee-1`.

2. **Open the ports**, before the first rung is deployed. Each rung's peer port, `10006 + 10 × s`, to
   everyone. Each rung's Bee API, `10005 + 10 × s`, to the stage hosts that publish through it and to
   the control host, and to nobody else. The API asks for no password and can spend the node's
   postage, so it takes both of these:

   - **The bind.** The manager already binds each rung's API to `0.0.0.0`, because this is another
     host than the control host, so the API answers on every address from the first deploy. That is
     why the firewall below goes in first.
   - **The firewall.** Generate this host's table and name each allowed address once, as a `/32`:

     ```sh
     ./deploy/host/firewall-rules.sh --iface <public interface> --inventory firewall-inventory.json --bee-api-source <stage-host-address>/32 --bee-api-source <control-host-address>/32 > /tmp/bee-1-firewall.nft
     ```

   A provider firewall that admits the same addresses to the same ports does the same job.

3. **Create the pool.** **New deployment**, **Deployment type**, **ABR Node Pool**, with `bee-1` as
   the host. The manager creates one deployment per rung. Each rung's data, its wallet and keys
   included, lands on this host and nowhere else, so back it up before the host is ever rebuilt. Set
   `BEE_UPLOADER_NAT_ADDR` in each rung's settings to this host's public address, so peers can dial
   it, and deploy the rungs again.

4. **Fund each rung and buy its batch**, below.

5. **Hand the pool to an uploader.** Copy the pool string from the pool card into an **ABR Uploader**
   deployment on a stage host.

6. **The catalogue node.** **New deployment**, a Bee-only deployment with `bee-1` as the host, fund it
   and buy one immutable batch on it, below, of depth 18 or more: the manager refuses a shallower one
   for the catalogue, since its buckets fill after a few thousand writes. It holds the
   brand's catalogue alone: no pool string may name its batch or its Bee API, and the manager
   refuses a pool that does. Open its Bee API to the control host alone, where the admin writes
   through it, and designate it on **Manager settings**.

## Funding and stamping your Bee nodes

Every uploader Bee node needs two tokens on Gnosis Chain: xDAI for gas and xBZZ for its postage
batch and its chequebook. The manager holds no wallet. It shows each node's address, and you send the
tokens there from a wallet of your own.

1. **Read each node's address.** The pool card in the manager shows it, and so does the CLI from a
   checkout of `apps/hls-stream`:

   ```sh
   pnpm node:addresses
   ```

2. **Send xDAI and xBZZ to that address**, from your own wallet. A fraction of an xDAI covers a long
   time of gas. How much xBZZ depends on the batch you buy, and the next step prints the cost first.

3. **Buy a batch per rung.** From the pool card in the manager, or with the CLI. The batch is held by
   the node that bought it, so name the rung:

   ```sh
   pnpm stamp:buy --rung 360p <amount> <depth>
   ```

   It prints the cost and how long the batch lasts, and asks before it spends. Higher rungs burn
   postage faster, roughly seven times as fast at 1080p as at 360p, so watch the top rung's batch.

4. **Check the balances** at any time:

   ```sh
   pnpm node:wallets
   ```

   Watch `availableBalance` on a chequebook, not `totalBalance`. The difference is cheques already
   written that a peer has not cashed yet.

`apps/infra-manager/docs/features/abr-ladder.md` and `apps/hls-stream/packages/cli/README.md` have
the details of both paths.

## Firewall advice

- Close everything by default and open ports one role at a time, as the lists above say.
- Bind every Bee API, and the engines' HTTP ports, to a private address before opening anything.
  Docker publishes container ports around a host firewall's input rules, so the bind is what closes
  them. On any host other than the control host the manager binds a Bee API that a deployment's
  settings leave empty to `0.0.0.0`, so there the manager's nftables table, which filters Docker's
  published traffic too, or a provider firewall is what closes it, and it goes in before the first
  deploy.
- Never open a Bee API to a range wider than `/24`, and prefer a `/32` per host.
- Keep ssh to your own address and the control host's.
- Let the edge be the only public door to the consoles.

## The names that never change

Docker names a container, a network and a volume after its compose project, and each deploy script
finds its files under a fixed host folder. Rename either and the next deploy starts a fresh, empty
project beside the old one: a new database with no users, a new certificate store. So these names
stay what they are, whatever the files are called in the repository. The folders are defaults, and
each one has a setting that moves it. Once a host runs, keep that setting as it is.

| Piece                 | Host folder, and the setting that moves it                                                                                                                  | Compose project                                                | Volumes                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------- |
| Web2 admin            | `/opt/streaming/streaming-monorepo`, `--remote-path`                                                                                                        | `web2-admin-<profile>`, `web2-admin-default` without a profile | `pg-data`                     |
| Edge                  | `deploy/edge/` under the admin's folder, `--remote-path`                                                                                                    | `edge`                                                         | `caddy-data`, `caddy-config`  |
| Manager               | `/opt/streaming/streaming-infra-manager`, `MANAGER_ROOT` in `manager/.env`                                                                                  | `manager`                                                      | `manager-pg`                  |
| The manager's stacks  | `/opt/streaming/streaming-infra-manager-versions` and `/opt/streaming/streaming-infra-manager-data/<deployment>`, `STACK_VERSIONS_ROOT` and `BEE_DATA_ROOT` |                                                                |                               |
| The manager's ssh key | `/opt/streaming/manager-ssh`, `MANAGER_SSH_DIR`                                                                                                             |                                                                |                               |
| A stack deployment    | `~/swarm-hls-stream-<profile>` of the account the manager logs in as                                                                                        | the deployment's profile name                                  | `srs-media`, `uploader-state` |
