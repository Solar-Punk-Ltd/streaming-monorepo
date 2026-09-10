# Four shared rules on the VPC plus one SRT rule per stage, and the implied deny-all-ingress
# behind them.

# SRT ingest, one rule per stage and targeted by that stage's own tag: a port opened for one
# stage must never be satisfiable on another, because the slot arithmetic that decides what binds
# where lives above Terraform. Absent rather than empty while no stage exists (the M1 state) for
# the same reason as before: GCP reads an empty ports list as every UDP port.
resource "google_compute_firewall" "srt_ingest" {
  for_each = var.stages

  name    = "${var.name_prefix}-srt-ingest-${each.key}"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "udp"
    ports    = [tostring(each.value.srt_port)]
  }

  # The committed sources plus whatever scripts/allow-me.sh wrote for this test window.
  source_ranges = distinct(concat(var.srt_source_ranges, var.srt_operator_source_ranges))
  target_tags   = ["${local.stage_tag}-${each.key}"]

  # In a system with no application auth, matching this rule is the only authorization event
  # there is, so it is the only record of who reached the media port.
  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}

# SSH only from the IAP forwarding range: no host has a publicly reachable sshd.
resource "google_compute_firewall" "iap_ssh" {
  name    = "${var.name_prefix}-iap-ssh"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [local.iap_source_range]
  target_tags   = [local.stage_tag, local.monitoring_tag]

  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}

# node_exporter scrape. Identity-based on both sides because GCP rejects a rule that mixes
# service account filters with network tags, and the monitoring SA is a tighter source than
# its subnet would be. Two consequences: a source-SA filter never matches traffic sent to an
# instance's external address, so the rendered Prometheus targets must stay internal IPs; and
# the monitoring host's own target is its internal address, delivered host-locally without ever
# being evaluated against a VPC rule, so it needs no rule of its own.
resource "google_compute_firewall" "monitoring_scrape" {
  name    = "${var.name_prefix}-monitoring-scrape"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = [tostring(local.node_exporter_port)]
  }

  source_service_accounts = [google_service_account.monitoring.email]
  target_service_accounts = [google_service_account.stage.email]

  # No log_config here on purpose: at a 15s scrape interval this is about four connections a
  # minute of pure noise, and it would bury the two rules whose matches mean something.
}

# Log shipping, the scrape rule's mirror image: Alloy on each stage host pushes container logs
# to Loki on the monitoring host, so the service accounts swap sides. The two consequences of a
# source-SA filter carry over unchanged. The push URL must be the monitoring host's internal
# address, because such a filter never matches traffic aimed at an external one — which is why
# the address is reserved and why the startup templates are handed it rather than a hostname.
# And the monitoring host's own Alloy reaches Loki over that same internal address host-locally,
# delivered without ever being evaluated against a VPC rule, so it needs no rule of its own.
resource "google_compute_firewall" "loki_push" {
  name    = "${var.name_prefix}-loki-push"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = [tostring(local.loki_port)]
  }

  source_service_accounts = [google_service_account.stage.email]
  target_service_accounts = [google_service_account.monitoring.email]

  # No log_config, for the same reason as the scrape rule above: Alloy pushes in a batch every
  # few seconds for as long as a host is up, so every match here is noise.
}

# Forward-compatible only: the manager's web container publishes on 127.0.0.1:${WEB_PORT}
# today, so nothing off-host can reach it and the working path is
# `ssh -L 8080:localhost:8080 <alias>`. This rule matters only if that bind ever widens.
resource "google_compute_firewall" "manager_ui_iap" {
  name    = "${var.name_prefix}-manager-ui-iap"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = [tostring(local.manager_web_port)]
  }

  source_ranges = [local.iap_source_range]
  target_tags   = [local.stage_tag]

  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}

# Loki's push port, opened to named public addresses: the Bee hosts at Vultr (terraform/vultr),
# whose Alloy ships container logs into the same Loki the stage hosts do. The internal, identity
# based loki_push rule above cannot serve them — a source-service-account filter never matches
# traffic from outside the project, let alone outside GCP — so this is IP-keyed, and the addresses
# are reserved on the Vultr side precisely so a rebuild there does not invalidate the rule here.
#
# Absent rather than empty when the list is: GCP reads an omitted source_ranges as 0.0.0.0/0, and
# Loki has no authentication, so an empty list must mean "no rule" and never "everyone".
resource "google_compute_firewall" "loki_push_external" {
  count = length(var.loki_push_source_ranges) > 0 ? 1 : 0

  name    = "${var.name_prefix}-loki-push-external"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = [tostring(local.loki_port)]
  }

  source_ranges           = var.loki_push_source_ranges
  target_service_accounts = [google_service_account.monitoring.email]

  # Logged, unlike the two service-account rules it sits beside. Those are host-to-host chatter
  # inside one project; this one admits an unauthenticated write from the public internet, so
  # every match is worth a record — the same call as the SRT ingest rule.
  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}

# sshd on the stage hosts, opened to named public addresses: the streaming-infra-manager host,
# which deploys the ABR uploader over plain ssh from a container and has no gcloud and no Google
# identity to open an IAP tunnel with. Stage tag only — nothing external deploys to the monitoring
# host, so its sshd stays IAP-only. Absent while the list is empty, for the same reason as the
# Loki rule above: an omitted source_ranges would mean everyone.
resource "google_compute_firewall" "ssh_external" {
  count = length(var.ssh_source_ranges) > 0 ? 1 : 0

  name    = "${var.name_prefix}-ssh-external"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.ssh_source_ranges
  target_tags   = [local.stage_tag]

  # Internet-facing, so logged like the SRT and external Loki rules.
  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}
