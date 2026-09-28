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
because it puts the stack and the Bee nodes on the other hosts, then the admin, which needs a Bee
node from them and learns each stage's ingest address from the manager, and the edge last, because it checks that each console answers
before it serves it.

1. **An ssh alias on your machine**, in `~/.ssh/config`. The forward is the way into the manager
   before the edge serves it, and stays the way in when the edge is down.

   ```
   Host control-1
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
   ./deploy/deploy.sh control-1
   ```

   It worked when the deploy ends without an error and `http://localhost:8080` shows the manager's
   sign-in page while `ssh control-1` is open. The first deploy takes a while, because the host
   builds the stack version the manager bundles.

4. **The manager's first user**, on the host. It asks for the password twice.

   ```sh
   cd /opt/streaming/streaming-infra-manager/manager && docker compose exec -it api node dist/cli.js user:add <username>
   ```

5. **The manager's deploy key**, which it logs in to the stage and Bee hosts with. It lives on the
   host in `/opt/streaming/manager-ssh/`, as a key pair named `deploy_key` beside an `ssh_config` and
   a `known_hosts`. "Deploying Bee nodes to other hosts" in `apps/infra-manager/deploy/README.md`
   shows how to make it. The one line of `deploy_key.pub` is what the stage and Bee hosts authorize.

6. **The stage and Bee hosts**, by their recipes below, as far as a running ABR Uploader
   deployment. The admin needs no Bee node, batch or ingest address of its own: it writes the
   catalogue through the catalogue node and batch the manager designates and pushes, refusing to
   publish, saying why, until the manager has, and a stream's OBS details come from its stage.

7. **The web2 admin.** From `apps/web2-admin`, make the profile's env file from the sample and fill
   in what it asks for: `POSTGRES_PASSWORD`, `FEED_PRIVATE_KEY` and `INTERNAL_API_TOKEN`. Generate
   your own feed key and token. The sample's values are public and the deploy script refuses them.
   The `INGEST_*` keys, `BEE_URL` and `POSTAGE_BATCH_ID` an older env file carries are no longer
   read, and the deploy names each one it finds.

   ```sh
   cp backend/.env.sample backend/.env.brand-a
   ```

   ```sh
   ./deploy/deploy.sh --host=control-1 --profile=brand-a
   ```

   It worked when the deploy reports the API and the console healthy and prints the console's
   loopback port, 9090 unless a port slot says otherwise, and the command that makes the admin's
   first user. Run that command once. `--remote-path` puts the checkout somewhere other than
   `/opt/streaming/streaming-monorepo`.

8. **The edge.** Point an A record for each name at the host first. A name that does not resolve
   turns every certificate attempt into a failure, and Let's Encrypt limits those. Then, from the
   repository root, make the edge's env file and set `MANAGER_DOMAIN` and `ADMIN_DOMAIN`:

   ```sh
   cp infra/edge/.env.sample infra/edge/.env
   ```

   ```sh
   ./infra/edge/edge.sh --host=control-1
   ```

   It worked when `https://manager.example.org` and `https://admin.example.org` show the two sign-in
   pages. A host that runs the manager alone leaves `ADMIN_DOMAIN` empty.

9. **Link the uploader to the admin.** In the ABR Uploader deployment's settings in the manager, set
   `ADMIN_API_URL` to `https://admin.example.org` and `ADMIN_API_TOKEN` to the admin's
   `INTERNAL_API_TOKEN`, then press **Test connection**.
   `apps/infra-manager/docs/features/web2-admin-link.md` has the details.

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

6. **Deploy onto it.** **New deployment**, with `stage-1` as the host. The deployment's port slot
   decides its ports, as [architecture/overview.md](architecture/overview.md#ports) lists.

7. **Open the public ports**, and only those: SRT ingest, the viewer page and the two Bee peer ports
   of each slot. "Opening the manager to the internet" in `apps/infra-manager/deploy/README.md` binds
   the node and engine APIs off the public interface and generates an nftables table for exactly
   this. It worked when an encoder reaches the SRT port, a browser opens the viewer page, and a port
   ending in 5 or 7 does not answer from outside.

## A Bee host

A Bee host carries the Bee nodes of ABR node pools, one node per quality rung, which the uploaders on
stage hosts publish through. It is prepared like a stage host.

1. **Steps 1 to 5 of the stage host**, with this host's address and an alias such as `bee-1`.

2. **Create the pool.** **New deployment**, **Deployment type**, **ABR Node Pool**, with `bee-1` as
   the host. The manager creates one deployment per rung. Each rung's data, its wallet and keys
   included, lands on this host and nowhere else, so back it up before the host is ever rebuilt. Set
   `BEE_UPLOADER_NAT_ADDR` in each rung's settings to this host's public address, so peers can dial
   it, and deploy the rungs again.

3. **Open the ports.** Each rung's peer port, `10006 + 10 × s`, to everyone. Each rung's Bee API,
   `10005 + 10 × s`, to the stage hosts that publish through it and to the control host, and to
   nobody else. The API asks for no password and can spend the node's postage, so it takes both of
   these:

   - **The bind.** Set `BEE_UPLOADER_API_BIND` to `0.0.0.0` in each rung's settings and deploy the
     rungs again. Do it only together with the firewall below.
   - **The firewall.** Generate this host's table and name each allowed address once, as a `/32`:

     ```sh
     ./deploy/host/firewall-rules.sh --iface eth0 --inventory firewall-inventory.json --bee-api-source <stage-host-address>/32 --bee-api-source <control-host-address>/32 > /tmp/bee-1-firewall.nft
     ```

   A provider firewall that admits the same addresses to the same ports does the same job.

4. **Fund each rung and buy its batch**, below.

5. **Hand the pool to an uploader.** Copy the pool string from the pool card into an **ABR Uploader**
   deployment on a stage host.

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
  them.
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
