# Hosts: roles, the edge, recipes, and the names that never change

A host is a Linux machine with Docker on it. The platform uses three kinds, and one machine can
carry all three at once, or each role can have machines of its own. This page says what runs on
each kind, who puts it there, which folder of this repository owns it, what the edge is, how to
set up each kind from nothing, and which names on the hosts must never change however the
repository is rearranged. No real host, address or domain appears here: those belong to one
deployment and live in its env files, which are not committed.

## The three roles

| Role                        | What runs there                                                                                                                             | Who puts it there                                                                                                                                                                                               | Owning folder                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Control host                | The edge, the manager, the admin console, and on the pilot's monitoring host the monitoring stack (Prometheus, Alertmanager, Loki, Grafana) | Each project's own deploy script, run by a person from a checkout: `infra/edge/edge.sh`, `apps/infra-manager/deploy/deploy.sh`, `apps/web2-admin/deploy/deploy.sh`, `infra/terraform/stacks/monitoring/push.sh` | `infra/edge`, `apps/infra-manager/deploy`, `apps/web2-admin/deploy`, `infra/terraform/stacks/monitoring` |
| Stage host                  | One stack deployment per profile and port slot: the ingest engine (SRS or OME), the uploader, a Bee gateway, the viewer                     | The manager, which runs the stack's `deploy.sh` on the host over ssh, or on its own host as `localhost`                                                                                                         | `apps/hls-stream/deploy`                                                                                 |
| Bee host                    | The Bee nodes of an ABR node pool, one per quality rung, which are the publish targets of a stage host's uploader                           | The manager                                                                                                                                                                                                     | `apps/hls-stream/deploy`                                                                                 |
| Every host Terraform builds | The bare machine: Docker, the firewall, node_exporter, and Alloy shipping logs to the monitoring host                                       | Terraform's first-boot scripts                                                                                                                                                                                  | `infra/terraform`                                                                                        |

The roles describe what runs where, not how many machines there are. A control host that also
carries stack deployments is a stage host as well, and the pilot's cloud hosts split the roles
across machines that Terraform builds.

## The edge

The edge is the front door of a control host: one small Caddy container that holds the two ports
every browser uses, 80 and 443, gets and renews the HTTPS certificates by itself, and sends each
domain to the console behind it, the admin's or the manager's. The consoles themselves listen on
the host's loopback only, so without an edge the way in is an ssh tunnel. The viewer and the
ingest ports do not pass through it.

Only one program per host can hold ports 80 and 443. That is why the edge is a compose project of
its own rather than a service inside each console's project, and why `edge.sh` refuses to start
when something else already holds them. It is the one edge on every control host, whichever
consoles the host runs: the manager has no edge of its own, and its domain goes into the edge's
env file beside the admin's.

`infra/edge/edge.sh` renders a Caddyfile from `infra/edge/.env`, copies it and the compose file to
the host, and starts or recreates the container. The certificates live in two named volumes, so a
recreate does not ask for new ones.

## Setting up a fresh host

These recipes start from a machine with nothing on it, made by hand or built by the Terraform in
`infra/terraform`. They describe new hosts only: nothing here moves a host that already runs
something onto this layout.

The control host comes first. A stage host and a Bee host are prepared for the manager, and the
manager then puts everything else on them, so both need the running control host, whose manager
holds the deploy key it logs in with. The examples use the documentation addresses `203.0.113.7`
for a stage host and `203.0.113.8` for a Bee host, and `deploy` as the account the manager logs in
as. Put your own in their place.

### A control host, made by hand

A control host runs the manager, the admin console and the edge in front of them. Each is brought
up by its own script, run from a checkout of this repository on your own machine, in the order
below: the manager first, because it puts the stack and the Bee nodes on the other hosts, then the
admin, which needs a Bee node and an ingest address from them, and the edge last, because it
checks that each console answers before it serves it.

The manager and the admin expect the account `solarpunk`: the manager's compose file mounts paths
under `/home/solarpunk`, and both scripts default to folders there. The examples use
`203.0.113.6` for the control host, `control-1` as its ssh alias on your machine, and
`manager.example.org` and `admin.example.org` as the two names.

1. **Docker, Compose v2, rsync and curl.** On a Debian or Ubuntu host, as a user with sudo.

   ```sh
   sudo apt-get update
   ```

   ```sh
   sudo apt-get install -y docker.io docker-compose-v2 rsync curl
   ```

   It worked when `docker compose version` prints a version.

2. **The account `solarpunk`**, in the `docker` group, with your own key in its
   `authorized_keys`.

   ```sh
   sudo useradd --create-home --shell /bin/bash solarpunk
   ```

   ```sh
   sudo usermod -aG docker solarpunk
   ```

   It worked when `ssh solarpunk@203.0.113.6 docker ps` from your machine prints an empty table.

3. **The firewall.** Tcp 22 from your own address, and tcp 80 and 443 from anywhere, because Let's
   Encrypt checks the names from addresses it does not publish. Add udp 443 for HTTP/3 if you
   want it. Nothing else: both consoles listen on the host's loopback only.

4. **An ssh alias on your machine**, in `~/.ssh/config`. The forward is the way into the manager
   before the edge serves it, and stays the way in when the edge is down.

   ```
   Host control-1
     HostName 203.0.113.6
     User solarpunk
     LocalForward 8080 localhost:8080
   ```

5. **The manager.** On the host, make its folder:

   ```sh
   mkdir -p ~/streaming-infra-manager/manager
   ```

   On your machine, from `apps/infra-manager`, make `manager/.env` from the sample and set at
   least `POSTGRES_PASSWORD`. The file travels with every deploy, so your checkout is its source.

   ```sh
   cp manager/.env.sample manager/.env
   ```

   Then deploy:

   ```sh
   ./deploy/deploy.sh control-1
   ```

   It worked when the deploy ends without an error and `ssh control-1` followed by
   `http://localhost:8080` in a browser shows the manager's sign-in page. The first deploy takes
   a while: the host builds the manager's images and the stack version it bundles.

6. **The manager's first user**, on the host:

   ```sh
   cd ~/streaming-infra-manager/manager && docker compose exec -it api node dist/cli.js user:add <username>
   ```

   It asks for the password twice. It worked when you can sign in through the tunnel.

7. **The manager's deploy key**, which it logs in to the stage and Bee hosts with. It lives on the
   host in `~/manager-ssh/`, as a key pair named `deploy_key` beside an `ssh_config` and a
   `known_hosts`. Make it there as "Deploying Bee nodes to other hosts" in
   `apps/infra-manager/deploy/README.md` shows.

   It worked when `~/manager-ssh/deploy_key.pub` holds one line. That line is what a stage host
   and a Bee host authorize, in their recipes below.

8. **The stage and Bee hosts**, by their recipes below, as far as a running ABR Uploader
   deployment. The admin needs its ingest address and a Bee node with a usable postage batch.

9. **The admin.** On your machine, from `apps/web2-admin`, make the profile's env file from the
   sample and fill in what it asks for: `POSTGRES_PASSWORD`, `FEED_PRIVATE_KEY`,
   `INTERNAL_API_TOKEN`, `BEE_URL` and `POSTAGE_BATCH_ID` of the Bee node it writes through, and
   `INGEST_HOST`, the stage host encoders send to. The sample says what each one is, and the
   script refuses a missing or malformed key before anything leaves your machine.

   ```sh
   cp backend/.env.sample backend/.env.brand-a
   ```

   Then deploy:

   ```sh
   ./deploy/deploy.sh --host=control-1 --profile=brand-a
   ```

   It worked when the deploy ends by reporting the API and the console healthy and prints the
   console's loopback port, 9090 unless a port slot or `WEB2_ADMIN_WEB_PORT` says otherwise. It
   also prints the command that makes the admin's first user. Run it once.

10. **Link the uploader to the admin.** In the manager, give the ABR Uploader deployment the
    admin's address and its `INTERNAL_API_TOKEN`, as `ADMIN_API_URL` and `ADMIN_API_TOKEN`.
    `apps/infra-manager/docs/features/web2-admin-link.md` has the details.

11. **The edge.** Point an A record for each name at the host first. A name that does not
    resolve turns every certificate attempt into a failure, and Let's Encrypt limits those. Then,
    from the repository root on your machine, make the edge's env file and set `MANAGER_DOMAIN`
    and `ADMIN_DOMAIN`, and the two ports if they are not 8080 and 9090:

    ```sh
    cp infra/edge/.env.sample infra/edge/.env
    ```

    ```sh
    ./infra/edge/edge.sh --host=control-1
    ```

    It worked when the run says each console answers on its loopback port and each name has a
    valid certificate, and `https://manager.example.org` and `https://admin.example.org` show
    the two sign-in pages. A certificate still coming does not fail the run: Caddy keeps asking,
    usually for under a minute.

The manager's own steps for going public, binding the node APIs and generating the host firewall,
are in "Opening the manager to the internet" in `apps/infra-manager/deploy/README.md`, and apply
to this host too when it also carries stack deployments.

### A control host that runs the manager alone

Steps 1 to 8 and 11 of the control host above, with `ADMIN_DOMAIN` left empty in the edge's env
file. The edge makes its own folder on the host, `deploy/edge/` under
`/home/solarpunk/streaming-monorepo`, where the admin's checkout would be.

It worked when `https://manager.example.org` shows the manager's sign-in page.

### One command for all three

**Not written yet.** There is no single command that brings up the manager, the admin and the
edge together. Each keeps its own compose project, its own database and its own folder on the
host, so the three scripts above, run in that order, are the way to set up a control host.

### A control host built by the Terraform

The GCP root in `infra/terraform` builds its monitoring host as the control host: steps 1 and 2
are done by its first-boot script, and its firewall opens tcp 80 and 443 to the internet for the
edge. Steps 3 to 11 are yours, with the host's external address. Put that address in
`ssh_source_ranges` and the manager's `deploy_key.pub` in `additional_ssh_public_keys`, in both
roots' tfvars, and apply both, so the stage and Bee hosts let the manager in.

### A stage host, made by hand

A stage host carries stack deployments: the ingest engine, the uploader, the viewer and their Bee
nodes, one deployment per profile and port slot. The manager sends each one over ssh and builds
its images on the host itself, so the host needs room for Docker builds as well as for running
them.

1. **Docker, Compose v2 and rsync.** On a Debian or Ubuntu host, as a user with sudo. Ubuntu's own
   archive names the Compose plugin `docker-compose-v2` and Docker's apt repository names it
   `docker-compose-plugin`, so install whichever your sources offer.

   ```sh
   sudo apt-get update
   ```

   ```sh
   sudo apt-get install -y docker.io docker-compose-v2 rsync
   ```

   It worked when `docker compose version` prints a version.

2. **The account the manager logs in as**, in the `docker` group. It needs no sudo.

   ```sh
   sudo useradd --create-home --shell /bin/bash deploy
   ```

   ```sh
   sudo usermod -aG docker deploy
   ```

   It worked when `id deploy` lists `docker` among the groups.

3. **The manager's deploy key.** Copy the one line of `~/manager-ssh/deploy_key.pub` from the
   control host, then on this host:

   ```sh
   sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
   ```

   ```sh
   echo '<the line from deploy_key.pub>' | sudo tee -a /home/deploy/.ssh/authorized_keys
   ```

   ```sh
   sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys && sudo chmod 600 /home/deploy/.ssh/authorized_keys
   ```

   It worked when `sudo cat /home/deploy/.ssh/authorized_keys` shows that line.

4. **Let only the control host in on ssh.** In the provider's firewall, or the host's own, admit
   tcp 22 from the control host's address and from your own while you set up, and nothing else
   yet. The public ports come in step 8, once the manager knows what it put here.

5. **Tell the control host about this host.** On the control host, add a block for it to
   `~/manager-ssh/ssh_config`. `IdentityFile` is the path inside the manager's container, where
   that folder is mounted at `/root/.ssh`. The alias must have no dot in it.

   ```
   Host stage-1
     HostName 203.0.113.7
     User deploy
     IdentityFile /root/.ssh/deploy_key
   ```

   Then record the host key, because the manager refuses a host it does not already know:

   ```sh
   ssh-keyscan -H 203.0.113.7 >> ~/manager-ssh/known_hosts
   ```

   It worked when the next step does. The manager's deploy README explains the folder, "Deploying
   Bee nodes to other hosts" in `apps/infra-manager/deploy/README.md`.

6. **Verify it in the manager.** Sign in, open **Host**, and under **Deploy targets** enter
   `stage-1` and press **Verify target**. The manager runs `docker info` over ssh and records the
   Docker daemon it finds.

   It worked when the target shows `Verified` with a date and a Docker daemon id. An error there
   names what failed: the alias, the key or the host key.

7. **Deploy onto it.** In the manager, **New deployment**, with `stage-1` as the host. Use the
   alias or `deploy@203.0.113.7`, the same spelling you verified. The deployment's port slot
   decides its ports, `10000 + 10 × slot` upwards (the stack's deploy README has the table,
   "--portSlot" in `apps/hls-stream/deploy/README.md`).

   It worked when the deployment reports running and its component links open.

8. **Open the public ports.** For each port slot on the host, the public ports are:

   | Port             | Protocol | What it is                            |
   | ---------------- | -------- | ------------------------------------- |
   | `10001 + 10 × s` | udp      | SRT ingest, what an encoder sends to  |
   | `10004 + 10 × s` | tcp      | the viewer page                       |
   | `10006 + 10 × s` | tcp      | the uploader's Bee node, to its peers |
   | `10008 + 10 × s` | tcp      | the gateway's Bee node, to its peers  |

   Every other port from 10000 to 19999 stays closed. The Bee node APIs above all, because they
   ask for no password and can spend the node's postage. The manager writes a firewall for exactly
   this: steps 2 and 3 of "Opening the manager to the internet" in
   `apps/infra-manager/deploy/README.md` bind the node and engine APIs off the public interface and
   generate an nftables table from the manager's own record of the host, with `stage-1` as the
   alias.

   It worked when an encoder reaches the SRT port and a browser opens the viewer page, and a port
   ending in 5 or 7 does not answer from outside.

### A stage host built by the Terraform

The GCP root in `infra/terraform` builds stage hosts with steps 1 and 2 done by their first-boot
script, as the account `solarpunk`, and with steps 3 and 4 done by its variables:
`additional_ssh_public_keys` carries the control host's `deploy_key.pub`, and `ssh_source_ranges`
carries the control host's address. Its firewall admits one SRT port per stage,
`stages.<key>.srt_port`, which you set to `10001 + 10 × s` once the manager has handed the
deployment its slot, and apply again. Then do steps 5 to 7 above with the host's external address
and `solarpunk` as the user. The Terraform README has the rest, "M2, stage 1" in
`infra/terraform/README.md`.

### A Bee host, made by hand

A Bee host carries the Bee nodes of ABR node pools, one node per quality rung, which the
uploaders on stage hosts publish through. It is prepared exactly like a stage host, with one
difference in the ports, and the manager puts the nodes on it as a pool rather than as a single
deployment.

1. **Steps 1 to 6 of the stage host above**, with this host's address and an alias such as
   `bee-1`.

2. **Create the pool on it.** In the manager, **New deployment**, **Deployment type**, **ABR Node
   Pool**, with `bee-1` as the host. The manager creates one deployment per rung and deploys them
   all. Each rung's data, its wallet and keys included, lands in `deploy/data/` under
   `~/swarm-hls-stream-<rung>` of the `deploy` account, and nothing else holds a copy, so back
   that folder up before the host is ever rebuilt.

   Then set `BEE_UPLOADER_NAT_ADDR` in each rung's settings to this host's public address, so each
   node announces an address its peers can dial rather than relying on detection, and deploy the
   rungs again.

   It worked when the pool's rungs report running on the pool card.

3. **Open the ports.** For each rung's port slot `s`:

   | Port             | Protocol | Who may reach it                                                               |
   | ---------------- | -------- | ------------------------------------------------------------------------------ |
   | `10006 + 10 × s` | tcp      | anyone: the rung's Bee node, to its peers                                      |
   | `10005 + 10 × s` | tcp      | the stage hosts that publish through it, and the control host, and nobody else |

   The second is the rung's Bee API. It asks for no password and can spend the node's postage, so
   it is opened to named addresses only. It has to be open to them, because the pool string the
   manager hands an uploader names each rung at this host's own address and that port, and the
   manager buys and reads the postage there. The manager's firewall generator closes this port as
   it does on a stage host, so on a Bee host that serves uploaders elsewhere, open it to those
   addresses in the provider's firewall instead, as the Terraform's Vultr root does.

   It worked when each rung's card shows its node answering.

4. **Fund each rung and buy its batch**, from the pool card, as "Using it" in
   `apps/infra-manager/docs/features/abr-ladder.md` describes. The manager shows each node's
   address and holds no wallet of its own: the xDAI and xBZZ are sent to that address by hand.

   It worked when every rung reports a live batch and the card offers the pool string.

5. **Hand the pool to an uploader.** Copy the pool string from the pool card into an **ABR
   Uploader** deployment on a stage host.

### A Bee host built by the Terraform

The Vultr root in `infra/terraform/vultr` builds Bee hosts with steps 1 to 4 of the stage host
done by its provisioning script and variables, as the account `solarpunk`, and the ports of step 3
opened in Vultr's firewall: the peer ports to everyone, and the Bee API band to the GCP stage
hosts and to the addresses in `bee_api_source_ranges`, which carries the control host's. Then do
steps 5 and 6 of the stage host and steps 2, 4 and 5 above, and set `BEE_UPLOADER_NAT_ADDR` to the
host's public address on every rung. The Vultr README has the rest, "Rollout" in
`infra/terraform/vultr/README.md`.

## The names that never change

Docker names a container, a network and a volume after its compose project, and a deploy script
finds its files under a fixed host folder. Rename either and the next deploy starts a fresh, empty
project beside the old one: a new database with no users, a new certificate store that asks for
certificates again. So these names are pinned by the scripts, written down here, and stay whatever
the files are called in the repository. Moving a folder in this tree never changes a name on a
host. On the host each volume carries its project's name in front, `web2-admin-brand-a_pg-data`,
`edge_caddy-data`, which is exactly why the project name is the thing to protect.

| Piece                        | Host folder                                                                                                                                                                              | Compose project                                                           | Volumes                          | Env file                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin console                | `/home/solarpunk/streaming-monorepo`                                                                                                                                                     | `web2-admin-<profile>`, and `web2-admin-default` when no profile is named | `pg-data`                        | `apps/web2-admin/backend/.env.<profile>` in the checkout it deploys from (`backend/.env` for the default profile), copied to the host on every deploy |
| Edge                         | `deploy/edge/` under `/home/solarpunk/streaming-monorepo`, where it was before its sources moved to `infra/edge/`                                                                        | `edge`                                                                    | `caddy-data`, `caddy-config`     | `infra/edge/.env` on the machine that runs `edge.sh`. Only the rendered Caddyfile goes to the host                                                    |
| Manager                      | `/home/solarpunk/streaming-infra-manager`, its compose run from the `manager/` folder inside it                                                                                          | `manager`, taken from that folder's name                                  | `manager-pg`                     | `manager/.env`, copied to the host on every deploy                                                                                                    |
| The stacks the manager keeps | `/home/solarpunk/streaming-infra-manager-versions` for the stack versions it builds, `/home/solarpunk/streaming-infra-manager-data/<deployment>` for each deployment's Bee data and keys |                                                                           |                                  |                                                                                                                                                       |
| A stack deployment           | the folder the stack's `deploy.sh` keeps for the profile, `~/swarm-hls-stream-<profile>` on a host it reaches over ssh                                                                   | the deployment's profile name, as it was chosen in the manager            | `srs-media`, `uploader-state`    | `.env.<profile>` at that folder's root and `engines/<engine>/.env.<profile>`, written by the manager                                                  |
| Monitoring stack             | `/home/solarpunk/monitoring` on the monitoring host, its data on the host's TSDB disk                                                                                                    | `devcon-monitoring`                                                       | bind mounts, in its compose file | rendered by Terraform and pushed by `push.sh`                                                                                                         |
| Log shipper                  | `/opt/devcon-alloy` on every host Terraform builds                                                                                                                                       | `devcon-alloy`                                                            |                                  | written by Terraform's first-boot script                                                                                                              |

For the hosts it builds, Terraform fixes the manager's host folder and the Bee data root at the
paths above, so the manager's deploy script and its data land where every other host has them.
