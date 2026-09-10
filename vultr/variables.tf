# Renaming a host key is a full destroy and recreate, not a rename: the reserved IP — the GCP
# allowlist identity, PUBLIC_HOST and the Bee NAT address all at once — goes with it, and so do
# the Bee wallets, keys and postage batches on the instance's disk. If a rename is ever needed,
# move the state with `moved` blocks first.
variable "bee_hosts" {
  type = map(object({
    region = string # fra | ams | ...  (Vultr region id, `vultr-cli regions list`)
    plan   = string # vc2-16c-64gb | vc2-8c-32gb | ...
  }))
  description = "One entry per Bee host. Adding a host must stay a .tfvars-only change: nothing in the resource graph may reference rungs, ladders, publishers or batches — only the slot COUNT, and only to size a port band."

  validation {
    # The key flows into three stricter namespaces: the Vultr instance hostname and label
    # (RFC1035-shaped), an ssh alias (a dot breaks swarm-hls-stream's target resolution) and the
    # Prometheus `stage` label, which is the join between a metric and a Loki log line. Rejecting
    # a bad key here keeps it from a half-built host.
    #
    # "monitoring" and anything starting with "stage" are reserved: these aliases are Included
    # into the same ~/.ssh/config as the GCP root's rendered aliases (see render.tf), and OpenSSH
    # resolves the FIRST match, so a collision would silently point a GCP alias at a Vultr host.
    # The GCP root's own stage keys are not readable from here — reserving the prefix it uses for
    # them is what can be enforced without a second remote-state read.
    condition = alltrue([
      for key in keys(var.bee_hosts) : can(regex("^[a-z]([a-z0-9-]*[a-z0-9])?$", key))
      ]) && alltrue([
      for key in keys(var.bee_hosts) : length(key) <= 40
      ]) && !contains(keys(var.bee_hosts), "monitoring") && alltrue([
      for key in keys(var.bee_hosts) : !startswith(key, "stage")
    ])
    error_message = "Bee host keys become Vultr hostnames, ssh aliases and Prometheus label values: lowercase letters, digits and hyphens only (no dots, underscores or uppercase), starting with a letter, at most 40 characters — and \"monitoring\" plus anything starting with \"stage\" are reserved for the GCP root's aliases, which share one ~/.ssh/config with these."
  }

  validation {
    condition = alltrue([
      for host in values(var.bee_hosts) :
      can(regex("^[a-z]{3,8}$", host.region)) && can(regex("^[a-z0-9-]+$", host.plan))
    ])
    error_message = "Each bee_hosts entry needs a Vultr region id (lowercase letters, e.g. \"fra\") and a plan id (e.g. \"vc2-16c-64gb\"). Both are interpolated into resource arguments and neither is discoverable from here — check them against `vultr-cli regions list` / `vultr-cli plans list`."
  }
}

# Capacity, not rung knowledge. The rule from docs/rollout/two-stage-terraform.md holds here
# unchanged: Terraform knows about hosts, never about rungs. The only thing these two numbers do
# is decide HOW MANY port slots the firewall has to admit — no resource is created per rung, and
# nothing in the graph knows which rung is which. Which ladder owns which slot, what bitrate a
# rung carries, and what a rung's batch is are all the manager's, above Terraform.
variable "ladders_per_host" {
  description = "ABR ladders one host is expected to carry. Only ever multiplied by rungs_per_ladder to size the Bee port band in the firewall group."
  type        = number
  default     = 3

  validation {
    # Cross-variable reference: a 1.9 feature, which is why versions.tf requires it. Checked once
    # here rather than in both variables, because the product is the thing with a limit — the
    # firewall rule budget in firewall.tf, which is one rule per P2P port.
    condition     = var.ladders_per_host >= 1 && floor(var.ladders_per_host) == var.ladders_per_host && var.ladders_per_host * var.rungs_per_ladder >= 1 && var.ladders_per_host * var.rungs_per_ladder <= 20
    error_message = "ladders_per_host must be a whole number ≥ 1, and ladders_per_host * rungs_per_ladder must land between 1 and 20 slots: each slot costs one P2P firewall rule, and a Vultr firewall group's rule budget (max_rule_count, commonly 50) is shared with the ssh, Bee API, scrape and ICMP rules."
  }
}

variable "rungs_per_ladder" {
  # Four is the shipped ABR ladder — 360p, 480p, 720p, 1080p — one bee-uploader profile per rung
  # (streaming-infra-manager/docs/features/abr-ladder.md). It is a variable rather than a literal
  # only so a shorter test ladder does not need an HCL edit.
  description = "Rungs in one ABR ladder, i.e. Bee publisher nodes per ladder. Only ever multiplied by ladders_per_host."
  type        = number
  default     = 4

  validation {
    condition     = var.rungs_per_ladder >= 1 && floor(var.rungs_per_ladder) == var.rungs_per_ladder
    error_message = "rungs_per_ladder must be a whole number ≥ 1."
  }
}

# Both ssh lists empty is the intended state between test windows: with no tcp/22 rule in the
# group, the host has no reachable sshd at all and the only way in is Vultr's own web console.
# Nothing on the host stops working — the Bee nodes keep publishing, node_exporter keeps being
# scraped, Alloy keeps pushing — because none of that arrives over port 22.
variable "ssh_source_ranges" {
  description = "Source ranges allowed to reach sshd on the Bee hosts. Empty (the default) means no sshd is reachable, which is the right resting state: put a static office or bastion address here, and use scripts/allow-me.sh for a laptop."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for range in var.ssh_source_ranges :
      can(cidrhost(range, 0)) && can(tonumber(split("/", range)[1])) && tonumber(split("/", range)[1]) >= 24
    ])
    error_message = "ssh_source_ranges entries must be valid CIDR blocks no wider than /24: this list is the entire ingress control for a root-capable sshd on a public address."
  }
}

# Laptop access for a test window, fed from the gitignored operator.auto.tfvars that
# scripts/allow-me.sh writes — same split as the GCP root's srt_operator_source_ranges, so a home
# address that changes with the router never churns through the committed roster.
variable "ssh_operator_source_ranges" {
  description = "Extra ssh source ranges for an operator's laptop during a test window. Written by scripts/allow-me.sh into operator.auto.tfvars (gitignored); never committed, empty at rest."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for range in var.ssh_operator_source_ranges :
      can(cidrhost(range, 0)) && can(tonumber(split("/", range)[1])) && tonumber(split("/", range)[1]) >= 24
    ])
    error_message = "ssh_operator_source_ranges entries must be valid CIDR blocks no wider than /24, exactly like ssh_source_ranges: the same sshd is behind them."
  }
}

# The streaming-infra-manager host. It deploys the Bee pools over ssh and then talks to every
# rung's API to buy and inspect postage batches, so it needs the same API band the GCP stage
# uploaders get. A separate list from the stage addresses because those come from the GCP root's
# state and this one is a plain address the operator commits; the two are merged in locals.tf.
variable "bee_api_source_ranges" {
  description = "Public addresses, besides the GCP stage hosts, allowed to reach the Bee API port band on every Bee host: the manager host that deploys the pools and manages their stamps. /32s."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for range in var.bee_api_source_ranges :
      can(cidrhost(range, 0)) && can(tonumber(split("/", range)[1])) && tonumber(split("/", range)[1]) >= 24
    ])
    error_message = "bee_api_source_ranges entries must be valid CIDR blocks no wider than /24: anyone who reaches the Bee API can spend the node's postage batches."
  }
}

# Further keys for user solarpunk, written by the provisioning script on first boot and on every
# re-run. ssh_public_key is the one Vultr installs for root at deploy and is ForceNew on the
# instance; this list is not tied to the instance at all, so a key can be added to a running host
# with an in-place startup-script update and one provision.sh re-run.
variable "additional_ssh_public_keys" {
  description = "OpenSSH public keys installed for solarpunk in addition to ssh_public_key: the manager host's deploy key. Applied by the provisioning script, so adding one never replaces the instance."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for key in var.additional_ssh_public_keys :
      can(regex("^(ssh-ed25519 AAAAC3NzaC1lZDI1NTE5|ssh-rsa AAAAB3NzaC1yc2E|ecdsa-sha2-nistp[0-9]+ AAAA)[A-Za-z0-9+/]{20,}={0,3}( |$)", key))
    ])
    error_message = "Every additional_ssh_public_keys entry must be a complete one-line OpenSSH public key."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH public key registered with Vultr and installed for root at deploy time; the provisioning script copies it to user solarpunk. Keep it identical to ../envs/poc.tfvars's key — one key across both roots is what lets one ssh_config reach every host."
  type        = string

  validation {
    # Same regex as the GCP root, for a sharper reason: this key is installed once, at instance
    # deploy, by Vultr itself. A malformed key does not fail the apply — it produces a running
    # host with a public address, an unauthenticated Bee API and no way in but the web console.
    condition     = can(regex("^(ssh-ed25519 AAAAC3NzaC1lZDI1NTE5|ssh-rsa AAAAB3NzaC1yc2E|ecdsa-sha2-nistp[0-9]+ AAAA)[A-Za-z0-9+/]{20,}={0,3}( |$)", var.ssh_public_key))
    error_message = "ssh_public_key must be a complete one-line OpenSSH public key (the full base64 body, not the tfvars placeholder), not a file path and not a private key."
  }
}

variable "ssh_identity_file" {
  description = "Private key path written into the rendered ssh_config as IdentityFile, so `ssh -F` (and the ~/.ssh/config Include) needs no -i. The key itself never passes through Terraform — only this path string."
  type        = string
  default     = "~/.ssh/dev-server.key"
}

variable "name_prefix" {
  description = "Prefix for host names, the firewall group description, the ssh key name and the Vultr tags."
  type        = string
  default     = "devcon"

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,10}[a-z0-9])?$", var.name_prefix))
    error_message = "name_prefix reaches Vultr hostnames (which are RFC1035-shaped) and tags: lowercase letters, digits and hyphens, starting with a letter and not ending in one, 12 characters at most. Keep it the same as the GCP root's."
  }
}

variable "os_id" {
  # 2284 = Ubuntu 24.04 LTS x64, the same family the GCP root's stage hosts run, so the
  # provisioning script's apt package names (docker.io, docker-compose-v2,
  # prometheus-node-exporter) are the ones that actually exist. Vultr identifies an OS by a
  # numeric id rather than an image family, so there is nothing to float here — look it up with
  #   vultr-cli os list | grep -i 'ubuntu 24.04'
  # or GET https://api.vultr.com/v2/os (needs the API key), and paste the number.
  description = "Vultr OS id to install. 2284 is Ubuntu 24.04 LTS x64."
  type        = number
  default     = 2284

  validation {
    condition     = var.os_id > 0 && floor(var.os_id) == var.os_id
    error_message = "os_id must be a positive whole number — a Vultr OS id, not a name."
  }
}

# The GCP root's state, read for two values: the stage hosts' external addresses (the only
# addresses allowed to reach an unauthenticated Bee API) and the monitoring host's (the scrape
# source and the Loki push target). Defaults match ../envs/poc.backend.hcl, so nothing has to be
# passed on the command line for the POC.
variable "gcp_state_bucket" {
  description = "GCS bucket holding the GCP root's state. Same bucket as this root's own backend; see ../envs/poc.backend.hcl."
  type        = string
  default     = "streaming-504704-devcon-tfstate"
}

variable "gcp_state_prefix" {
  description = "State prefix of the GCP root inside gcp_state_bucket. \"poc\" is what ../envs/poc.backend.hcl uses."
  type        = string
  default     = "poc"
}
