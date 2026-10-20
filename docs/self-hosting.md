# Running your own deployment

This guide takes you from empty machines to a live stream you run yourself. It covers what hardware to rent,
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

- **Control host**: small. Two cores, 4 GB of memory and 40 GB of disk run the manager, the
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

Then put your own public key into the account, so you can log in to it. The key is your own, the
one on the machine you run the deploy scripts from. The manager's deploy key comes later, on the
stage and Bee hosts. `~deploy` is the shell's name for the account's home folder.

```sh
sudo install -d -m 700 -o deploy -g deploy ~deploy/.ssh
```

```sh
echo '<your own public key, one line>' | sudo tee -a ~deploy/.ssh/authorized_keys
```

```sh
sudo chown deploy:deploy ~deploy/.ssh/authorized_keys && sudo chmod 600 ~deploy/.ssh/authorized_keys
```

It worked when `ssh deploy@203.0.113.6 docker ps` from your machine prints an empty table. Ubuntu's
own archive names the Compose plugin `docker-compose-v2` and Docker's apt repository names it
`docker-compose-plugin`, so install whichever your sources offer.

## The control host

The control host runs the manager, the admin and the edge. Each is brought up by its own script,
run from a checkout of this repository on your own machine, in this order: the manager first,
because it puts the stack and the Bee nodes on the other hosts, then the admin, which needs no
stage, no Bee node and no batch to start, and the edge last, because it checks that each console
answers before it serves it. The stages come after, from the manager, and each registers itself
with the admin. [architecture/stages.md](architecture/stages.md) is the design.

Each deploy names its build after the git tag on the commit it deploys, and the consoles show that
name to signed-in users. A first installation needs no tag: a build without one is named after its
commit. A release is tagged before its deploys, and [releasing.md](releasing.md) is that order.

On your own machine you need bash, ssh, rsync, git and Node 24, which run every deploy script and
the firewall generator of the Bee host. The stack's CLI needs pnpm as well, and `pnpm install` once
at the repository root.

Clone the repository and check out what you deploy. A release tag, `vX.Y.Z` with no suffix such as
`-rc.1`, marks a commit that was released in the order [releasing.md](releasing.md) describes. The
second command below lists the tags newest first. `main` works too and carries changes no release
has yet. Read this guide from the checkout you deploy, because a step can change between releases.

```sh
git clone https://github.com/Solar-Punk-Ltd/streaming-monorepo.git && cd streaming-monorepo
```

```sh
git tag --list 'v*' --sort=-v:refname
```

```sh
git checkout <the newest vX.Y.Z>
```

```sh
pnpm install
```

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
   and set at least `POSTGRES_PASSWORD`, for example with `openssl rand -hex 24`. The deploy
   refuses the sample's `pwd` unless `--allow-sample-secrets` is given for a test install. The file
   travels with every deploy, so your checkout is its source. Set `MANAGER_ROOT` there if the manager should live anywhere but
   `/opt/streaming/streaming-infra-manager`.

   ```sh
   cp manager/.env.sample manager/.env
   ```

   ```sh
   ./deploy/deploy.sh --host=<control-host>
   ```

   It worked when the deploy ends without an error and `http://localhost:8080` shows the manager's
   sign-in page while `ssh <control-host>` is open. The first deploy takes a while, because the host
   builds the stack version the manager bundles.

   A second manager host gets an env file of its own, `manager/.env.<name>` made from the same
   sample, and `--profile=<name>` deploys it to the host named. Every deploy names its host. There
   is no default. A deploy sends only the file
   it uses, and every host keeps it as `manager/.env`. Both flags also take their value as the next
   word, as in `--host <control-host>`.

   ```sh
   ./deploy/deploy.sh --host=<second-control-host> --profile=<name>
   ```

   Where the Bee and engine APIs answer needs no setting on a first install. Every Bee API and
   engine HTTP port the stack runs answers on the host's Docker bridge address wherever its own
   `*_BIND` setting is empty, because the API asks for no password and Docker publishes past a host
   firewall. The stack's deploy reads that address at deploy time. Under
   `COMPOSE_NETWORK=host` the Bee APIs listen there through `*_API_LISTEN` instead. "Check where the
   node and engine APIs answer" in `apps/infra-manager/deploy/README.md` names the settings. A
   client that dials a Bee API by `localhost`, `127.0.0.1` or the host's public or LAN address does
   not reach a node on the bridge. To keep a node open to such a client, give the deployment
   `0.0.0.0` in its own settings for that node's key, `BEE_UPLOADER_API_BIND`,
   `BEE_GATEWAY_API_BIND`, `BEE_RUNG_480P_API_BIND`, `BEE_RUNG_720P_API_BIND` or
   `BEE_RUNG_1080P_API_BIND`, and let the firewall decide who reaches it.

4. **The manager's first user**, on the host. Log in to it first, then make the user. It asks for
   the password twice.

   ```sh
   ssh <control-host>
   ```

   ```sh
   cd /opt/streaming/streaming-infra-manager/manager && docker compose exec -it api node dist/cli.js user:add <username>
   ```

5. **The manager's deploy key**, which it logs in to the stage and Bee hosts with. It lives on the
   host in `/opt/streaming/manager-ssh/`, as a key pair named `deploy_key` beside an `ssh_config` and
   a `known_hosts`. Make the key on the host, still logged in as in step 4:

   ```sh
   mkdir -p -m 700 /opt/streaming/manager-ssh
   ```

   ```sh
   ssh-keygen -t ed25519 -N '' -f /opt/streaming/manager-ssh/deploy_key
   ```

   "Deploying Bee nodes to other hosts" in `apps/infra-manager/deploy/README.md` shows the
   `ssh_config` and `known_hosts` beside it. The one line of `deploy_key.pub` is what the stage and
   Bee hosts authorize.

6. **The admin.** From `apps/web2-admin`, make the profile's env file from the sample and fill
   in what it asks for: `POSTGRES_PASSWORD`, `FEED_PRIVATE_KEY`, the brand key the catalogue is
   signed with, and `INTERNAL_API_TOKEN`, the registrar token: the token the manager presents when it registers
   each stage and the catalogue batch with the admin. Generate
   your own key and token. The sample's values are public and the deploy script refuses them,
   unless `--allow-sample-secrets` is given for a test install. Set `BRAND_WALLET_SECRET` only to
   fund nodes from the admin. The sample leaves it commented out. The admin takes no stage settings:
   no ingest address, port or passphrase, no Bee node and no batch. It learns each stage from the
   manager and writes the catalogue through the catalogue node the manager designates, refusing to
   publish, saying why, until the manager has.

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

   Then tell the manager what the edge holds. Docker reports no ports for a container on the
   host's network, and the manager refuses to remove or export anything on a host with an
   unexplained one. Add `KNOWN_HOST_NETWORK_PORTS=edge=80/tcp,443/tcp,443/udp` to the env file of
   step 3, `apps/infra-manager/manager/.env` in your checkout or the profile's own, and run the
   manager's deploy again.

   This recipe's control host does not need it. The manager checks the control host's own ports
   once, at its first start in step 3, before the edge exists, and after that only when it deploys
   to the control host itself, which this recipe never does. Add the line before the first
   deployment you make with **This machine** as its **Host**, or as soon as the manager reports "A
   host-network container has unknown bindings".

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

10. **The stage**, by the stage host recipe below: an **ABR uploader** deployment with the pool's
    string and a stream key of its own, which the wizard generates. Its Web2 admin group starts on,
    from the manager's link, with **A token of its own**. The first deploy generates that token and
    registers the stage with the admin before the uploader starts. It worked when the admin's
    **Stages** page lists the stage, ready, with "Its own token".

11. **The viewer and the first stream.** The viewer is a web player built for one feed, the
    brand's stream list, so it needs that feed's owner address and topic.
    1. **Read the feed's owner and topic.** Open `https://admin.example.org/api/config` in a
       browser. It needs no sign-in. Note `feed.owner`, the address of the brand key, written
       without `0x`, and `feed.topic`.
    2. **Make the viewer in the manager.** **New deployment**, then on **What to set up** pick
       **Watch a stream** and press **Continue**. On **Basics** give it a **Name**, pick **Another
       host over SSH** under **Host**, enter `stage-1`, the stage host of step 10, and press
       **Continue**. On **Settings**,
       under **Stream to follow**, pick **A streamer somewhere else** and paste `feed.owner` with
       `0x` in front. Put `feed.topic` in **Feed topic**. Press **Continue**, then **Deploy** on
       **Review**. The deployment's **Edit** drawer later shows the same owner field as
       **Streamer to follow**.
    3. **Find the viewer's address.** The deployment's page lists its ports. The viewer page is
       the one ending in 4, `10004 + 10 × s`, so on slot 3 it is `http://203.0.113.7:10034`. It
       worked when that address opens the player page.
    4. **Give the admin the viewer's address.** Set `VIEWER_BASE_URL` to that address in the env
       file of step 6, `apps/web2-admin/backend/.env.brand-a`, and run the admin's deploy of step 6
       again. It worked when `https://admin.example.org/api/config` shows it as `viewerBaseUrl`.
    5. **Make the first stream in the admin.** On **Streams**, press **Create New Stream**. Fill in
       **Stream Name**, pick the stage under **Stage**, set **Scheduled Date** and
       **Scheduled Time**, and press **Create Stream**. On the stream's page press **Publish**.
       It worked when the stream's page shows **OBS connection details** for that stage, and
       **Open player catalogue** opens the viewer with the stream listed.

To upgrade a running installation later, see
[Upgrading an existing installation](#upgrading-an-existing-installation) at the end of this page.

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
   come in step 6, before anything is deployed here.

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
   `BEE_GATEWAY_API_BIND` to that address in its settings, and only to the address the control host
   reaches this host on, its `HostName` in the manager's ssh config, because the manager dials the
   Bee API there.

   The generated table drops the RTMP port, the one ending in 2, like any other private port. The
   manager's console offers RTMP on every SRS stage all the same, because which ports are reachable
   is the firewall's job: open that port in the table if broadcasters are to use RTMP. The
   admin shows a brand's broadcasters SRT only, because streaming uses SRT. SRS allows play
   from its own container only, so an open RTMP port takes publishes and refuses playback.

   RTMP is not encrypted, so an open RTMP port puts every broadcaster's stream key at risk, as
   [Ports](architecture/overview.md#ports) in the architecture overview explains.

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
   - **The firewall.** An nftables table the manager's generator writes for this host. It filters
     the traffic Docker publishes as well, which a firewall such as ufw does not see.

   A provider firewall that admits the same addresses to the same ports does the same job, and then
   the steps below can be skipped. Otherwise:

   1. **Download the host's inventory.** It is a browser address, not a button in the console. Sign
      in to the manager, then open `https://manager.example.org/targets/firewall?alias=bee-1` in the
      same browser, or `http://localhost:8080/targets/firewall?alias=bee-1` while
      `ssh <control-host>` is open. Your sign-in is all it asks for. The browser saves
      `firewall-inventory.json`. The manager refuses the export, and says why, while something on
      that host is unfinished or unexplained.
   2. **Find the host's public interface**, on the Bee host. The name after `dev` is the one, such
      as `eth0`.

      ```sh
      ip -4 route show default
      ```

   3. **Generate the table**, on your own machine, from `apps/infra-manager`. Name each address
      that may reach the Bee API once, as a `/32`: every stage host that publishes through these
      rungs, and the control host. It prints the table and applies nothing.

      ```sh
      ./deploy/host/firewall-rules.sh --iface <public interface> --inventory <path to firewall-inventory.json> --bee-api-source 203.0.113.7/32 --bee-api-source 203.0.113.6/32 > /tmp/bee-1-firewall.nft
      ```

   4. **Copy it to the Bee host**, with your own account there, the one that can run `sudo`:

      ```sh
      scp /tmp/bee-1-firewall.nft <your account>@203.0.113.8:/tmp/bee-1-firewall.nft
      ```

   5. **Check it, then apply it**, on the Bee host. Keep that ssh session open until a second
      login works, so a mistake cannot lock you out. The check prints nothing when the file is
      valid.

      ```sh
      sudo apt-get install -y nftables
      ```

      ```sh
      sudo nft -c -f /tmp/bee-1-firewall.nft
      ```

      ```sh
      sudo nft -f /tmp/bee-1-firewall.nft
      ```

   6. **Keep it across a reboot.** Install it as a file of its own and have nftables load it at
      boot beside the host's own rules, never in place of them:

      ```sh
      sudo install -m 600 /tmp/bee-1-firewall.nft /etc/nftables-streaming.nft
      ```

      ```sh
      echo 'include "/etc/nftables-streaming.nft"' | sudo tee -a /etc/nftables.conf
      ```

      ```sh
      sudo systemctl enable nftables
      ```

      `/etc/nftables.conf` starts with `flush ruleset`, which also removes Docker's rules. So never
      restart the nftables service on a running host. A newer table is loaded with `sudo nft -f`,
      as in step 5, and installed again as in this step.

   It worked when `sudo nft list table inet streaming_infra_manager` prints the table with your
   addresses in its `bee_api_sources` set, a second ssh login works, and after `sudo reboot` the
   same command still prints it. Once the rungs run, a rung's Bee API port, `10005 + 10 × s`, does
   not answer from your own machine. Generate, check and apply the table again after you add a
   stage host.

3. **Create the pool.** **New deployment**, **What to set up**, **ABR node pool**,
   with `bee-1` as the host. The manager creates one deployment per rung. Each rung's data, its wallet and keys
   included, lands on this host and nowhere else, so back it up before the host is ever rebuilt. Set
   `BEE_UPLOADER_NAT_ADDR` in each rung's settings to this host's public address, so peers can dial
   it, and deploy the rungs again.

4. **Fund each rung and buy its batch**, below.

5. **Hand the pool to an uploader.** Copy the pool string from the pool card into an **ABR uploader**
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

1. **Read each node's address.** From the pool card in the manager.

2. **Send xDAI and xBZZ to that address**, from your own wallet. A fraction of an xDAI covers a long
   time of gas. How much xBZZ depends on the batch you buy, and the next step prints the cost first.

3. **Buy a batch per rung.** From the pool card in the manager. The batch is held by the node that
   bought it, so buy it on the rung it is for. Higher rungs burn postage faster, roughly seven times
   as fast at 1080p as at 360p, so watch the top rung's batch.

4. **Check the balances** at any time, on the pool card. Watch the available balance of a
   chequebook, not its total. The difference is cheques already written that a peer has not cashed
   yet.

The stack's CLI does the same for a stack you run by hand from a checkout of `apps/hls-stream`,
where `deploy/config.json` and `.env` name the node: `pnpm node:addresses`,
`pnpm stamp:buy --rung 360p <amount> <depth>` and `pnpm node:wallets`. It cannot reach a pool the
manager deployed unless you point it there with `--url` and the Bee host firewall admits your
address. `apps/infra-manager/docs/features/abr-ladder.md` and `apps/hls-stream/packages/cli/README.md`
have the details of both paths.

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
| Admin                 | `/opt/streaming/streaming-monorepo`, `--remote-path`                                                                                                        | `web2-admin-<profile>`, `web2-admin-default` without a profile | `pg-data`                     |
| Edge                  | `deploy/edge/` under the admin's folder, `--remote-path`                                                                                                    | `edge`                                                         | `caddy-data`, `caddy-config`  |
| Manager               | `/opt/streaming/streaming-infra-manager`, `MANAGER_ROOT` in `manager/.env`                                                                                  | `manager`                                                      | `manager-pg`                  |
| The manager's stacks  | `/opt/streaming/streaming-infra-manager-versions` and `/opt/streaming/streaming-infra-manager-data/<deployment>`, `STACK_VERSIONS_ROOT` and `BEE_DATA_ROOT` |                                                                |                               |
| The manager's ssh key | `/opt/streaming/manager-ssh`, `MANAGER_SSH_DIR`                                                                                                             |                                                                |                               |
| A stack deployment    | `~/swarm-hls-stream-<profile>` of the account the manager logs in as                                                                                        | the deployment's profile name                                  | `srs-media`, `uploader-state` |

The admin's host folder holds `apps/web2-admin` alone, whatever its name: its deploy sends the
admin's own folder, not the whole repository. The edge's source is `infra/edge/` in this repository,
and on the host its deploy puts it under the admin's folder as `deploy/edge/`.

## Upgrading an existing installation

An upgrade is a release deployed over the running hosts, in the order [releasing.md](releasing.md)
gives: tag the commit, deploy each manager, then deploy each admin. The manager then builds the
stack version of the new release, and each stage takes it when you deploy it again from the manager.
A manager page reads the manager's version once, when it loads, so reload every manager page that
was open through the upgrade.

Keep every host folder, compose project and volume name in
[the table above](#the-names-that-never-change) as it is.

A control host whose bundled stack runs from one stack folder, the one `SHLS_ROOT` names, rather
than from a build keeps its settings and its running deployments through a manager upgrade:

- The bundled version's first build takes `.env`, `deploy/config.json` and the engine env files from
  that folder, byte for byte, as its first settings revision. A config root that already holds
  settings is left alone.
- The manager only reads the folder, because the engines of the deployments that run from it mount
  it.
- Each such deployment keeps running from the folder until you deploy it again from the manager,
  which moves it onto a build. Updating the manager does not restart those deployments or discard
  their data.

An admin env file can carry keys the admin no longer reads, such as `INGEST_*`, `BEE_URL` and
`POSTAGE_BATCH_ID`. The admin's deploy names each one it finds, and you can delete them.
