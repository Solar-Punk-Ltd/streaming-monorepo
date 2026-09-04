variable "project_id" {
  description = "Existing GCP project. Terraform is a tenant here, not the owner of the project."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a well-formed GCP project id (6-30 characters: lowercase letters, digits and hyphens, starting with a letter and not ending in one). It is interpolated into an ssh ProxyCommand, so nothing else may pass."
  }
}

# Renaming a stage key is a full destroy and recreate, not a rename: both reserved addresses —
# the external one is the Hetzner allowlist identity — and both of its secrets go with it. If a
# rename is ever needed, move the state with `moved` blocks first.
variable "stages" {
  type = map(object({
    region   = string # europe-west3 | asia-south1
    srt_port = number
    machine  = string
  }))
  description = "One entry per stage host. Adding a stage must stay a .tfvars-only change: nothing in the resource graph may reference rungs, ladders, publishers or batches."

  validation {
    # The key flows into four stricter namespaces: instance names (RFC1035), GCP label values,
    # ssh aliases (a dot breaks swarm-hls-stream's target resolution) and the host map, where
    # "monitoring" is taken. Rejecting it here keeps a bad key from a half-built stage.
    condition = alltrue([
      for key in keys(var.stages) : can(regex("^[a-z]([a-z0-9-]*[a-z0-9])?$", key))
      ]) && !contains(keys(var.stages), "monitoring") && alltrue([
      for k in keys(var.stages) : length(k) <= 40
      ]) && alltrue([
      for s in values(var.stages) : s.srt_port >= 1 && s.srt_port <= 65535
    ])
    error_message = "Stage keys become instance names, GCP label values and ssh aliases: lowercase letters, digits and hyphens only (no dots, underscores or uppercase), starting with a letter, at most 40 characters (instance names cap at 63) — and \"monitoring\" is reserved for the monitoring host. srt_port must be a real port, 1-65535."
  }
}

variable "monitoring_region" {
  description = "Region for the single monitoring host. It comes up before any stage exists (M1)."
  type        = string
  default     = "europe-west3"
}

variable "monitoring_machine" {
  # ~4,500 series at a 15s interval fits with a large margin. Revisit when the stage logs start
  # shipping to Loki.
  description = "Machine type for the monitoring host."
  type        = string
  default     = "e2-standard-2"
}

variable "subnet_cidrs" {
  description = "Region to subnet CIDR. Every region used by a stage or by the monitoring host needs an entry."
  type        = map(string)
  default = {
    europe-west3 = "10.60.1.0/24"
    asia-south1  = "10.60.2.0/24"
  }

  validation {
    condition = alltrue([
      for region in distinct(concat([for s in values(var.stages) : s.region], [var.monitoring_region])) :
      contains(keys(var.subnet_cidrs), region)
    ]) && alltrue([for cidr in values(var.subnet_cidrs) : can(cidrhost(cidr, 0))])
    error_message = "Every region used by a stage or the monitoring host needs a valid CIDR entry in subnet_cidrs."
  }
}

variable "srt_source_ranges" {
  description = "Source ranges allowed to reach the SRT ingest port. No default on purpose: SRT ingest is unauthenticated at the network layer, so the caller has to name the test sources."
  type        = list(string)

  validation {
    condition = length(var.srt_source_ranges) > 0 && alltrue([
      for range in var.srt_source_ranges :
      can(cidrhost(range, 0)) && can(tonumber(split("/", range)[1])) && tonumber(split("/", range)[1]) >= 24
    ])
    error_message = "srt_source_ranges entries must be valid CIDR blocks no wider than /24: this list is the entire ingress control for an unauthenticated media port."
  }
}

# Laptop access for a test window. Fed from the gitignored operator.auto.tfvars that
# scripts/allow-me.sh writes, so a home address that changes with the router never churns through
# the committed roster. Empty is the production state: the venue encoder has a static address and
# belongs in srt_source_ranges.
variable "srt_operator_source_ranges" {
  description = "Extra SRT source ranges for an operator's laptop during a test window. Written by scripts/allow-me.sh into operator.auto.tfvars (gitignored); never committed, empty in production."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for range in var.srt_operator_source_ranges :
      can(cidrhost(range, 0)) && can(tonumber(split("/", range)[1])) && tonumber(split("/", range)[1]) >= 24
    ])
    error_message = "srt_operator_source_ranges entries must be valid CIDR blocks no wider than /24, exactly like srt_source_ranges: the same unauthenticated port is behind them."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH public key installed for user solarpunk through instance metadata."
  type        = string

  validation {
    # Requires a real key body, not just the type prefix: the tfvars placeholder would otherwise
    # apply successfully and leave three running hosts with no working way in (OS Login is off,
    # so a malformed metadata key is the only credential).
    condition     = can(regex("^(ssh-ed25519 AAAAC3NzaC1lZDI1NTE5|ssh-rsa AAAAB3NzaC1yc2E|ecdsa-sha2-nistp[0-9]+ AAAA)[A-Za-z0-9+/]{20,}={0,3}( |$)", var.ssh_public_key))
    error_message = "ssh_public_key must be a complete one-line OpenSSH public key (the full base64 body, not the tfvars placeholder), not a file path and not a private key."
  }
}

variable "stage_boot_disk_gb" {
  description = "Boot disk size for a stage host. Segments are transient; this holds the OS, images and the manager's Postgres."
  type        = number
  default     = 50
}

variable "monitoring_boot_disk_gb" {
  description = "Boot disk size for the monitoring host. The TSDB lives on its own disk."
  type        = number
  default     = 20
}

variable "tsdb_disk_gb" {
  # 30 days of node_exporter across three hosts is about 2.5 GB, and pd-balanced baseline IOPS
  # does not scale with size, so nothing is bought by over-provisioning. Disks grow online and
  # never shrink, so this is the size to start from rather than the size to land on.
  description = "Size of the separate persistent disk holding Prometheus, Loki, Grafana and Alertmanager data."
  type        = number
  default     = 30
}

variable "name_prefix" {
  description = "Prefix for every resource name and network tag."
  type        = string
  default     = "devcon"

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,10}[a-z0-9])?$", var.name_prefix))
    error_message = "name_prefix reaches service-account ids (a 30-character cap), instance names and the ssh ProxyCommand: lowercase letters, digits and hyphens, starting with a letter and not ending in one, 12 characters at most."
  }
}

variable "ssh_identity_file" {
  description = "Private key path written into the rendered ssh_config as IdentityFile, so `ssh -F` needs no -i. The key itself never passes through Terraform — only this path string."
  type        = string
  default     = "~/.ssh/dev-server.key"
}

variable "deployer_principals" {
  description = "Principals allowed to impersonate the deployer SA (e.g. a CI identity). Empty means the deployer stays inert and humans use their own gcloud credentials."
  type        = list(string)
  default     = []
}

variable "manage_project_services" {
  description = "Whether Terraform enables the project APIs it needs. Set false when the project's services are managed elsewhere."
  type        = bool
  default     = true
}
