# The two roots are deliberately separate states — a Vultr apply must not be able to touch a
# running GCP stage, and a GCP apply must not need a Vultr API key — but they are not
# independent: three of this root's rules are keyed on addresses only the GCP root knows.
#
# Read, never written: this is a data source, so nothing here can change the GCP root's state.
# Authentication is the gcs backend's own (Application Default Credentials, or
# GOOGLE_OAUTH_ACCESS_TOKEN, which scripts/allow-me.sh exports) — see versions.tf on why no
# google provider is declared.
data "terraform_remote_state" "gcp" {
  backend = "gcs"

  config = {
    bucket = var.gcp_state_bucket
    prefix = var.gcp_state_prefix
  }
}

locals {
  # try(), not a bare attribute read: a state with those outputs missing — an empty state because
  # init pointed at the wrong prefix, or a GCP root that has never been applied — would otherwise
  # fail with "this object does not have an attribute named stage_external_ips", which does not
  # say what to do. Turned into an empty value here and refused with a real message by the
  # preconditions on the firewall group in firewall.tf.
  gcp_stage_ips     = try(data.terraform_remote_state.gcp.outputs.stage_external_ips, {})
  gcp_monitoring_ip = try(data.terraform_remote_state.gcp.outputs.monitoring_external_ip, "")
}

# A plan-time warning that names the problem before an apply gets far enough to build a host with
# no way to reach it. A check block warns and does not block, which is the right strength for the
# monitoring value — a Bee host with no scrape rule still publishes — while the firewall group's
# preconditions are what actually stop an apply that would leave the Bee API unreachable from
# every stage.
check "gcp_remote_state" {
  assert {
    condition     = length(local.gcp_stage_ips) > 0
    error_message = "The GCP root's state has no stage_external_ips: apply ../ first (with at least one stage in ../envs/poc.tfvars), or fix gcp_state_bucket/gcp_state_prefix. Without it no stage host can reach the Bee API on these hosts, and the ladders publish nothing."
  }

  assert {
    condition     = local.gcp_monitoring_ip != ""
    error_message = "The GCP root's state has no monitoring_external_ip: apply ../ first. Without it these hosts get no node_exporter scrape rule and their Alloy has nowhere to push container logs."
  }
}
