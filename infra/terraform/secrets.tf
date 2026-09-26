# Write-only secret_data (`secret_data_wo`) fed by an ephemeral random_password was considered
# and rejected. An ephemeral generator re-opens on every run, which puts the M0 double-apply test
# at risk; a managed random_password lands in state either way; and the plan requires Terraform
# to render manager.env with the Postgres password in it. The state bucket stays the declared
# boundary — terraform/README.md says who that trusts.
#
# special = false throughout: these values travel through env files, a DATABASE_URL and an SRT
# stream id, where shell metacharacters and percent-encoding are a source of silent breakage.

resource "random_password" "srt_passphrase" {
  for_each = var.stages

  length  = 32
  special = false
}

resource "random_password" "postgres" {
  for_each = var.stages

  length  = 32
  special = false
}

resource "random_password" "grafana_admin" {
  length  = 32
  special = false
}

# The SRT passphrase is Terraform's only because it is generated here; the hand-authored
# swarm-hls-stream env consumes it, so a human fetches it with
# `gcloud secrets versions access latest --secret=<name>`.
resource "google_secret_manager_secret" "srt_passphrase" {
  for_each = var.stages

  project   = var.project_id
  secret_id = "${var.name_prefix}-srt-passphrase-${each.key}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "srt_passphrase" {
  for_each = var.stages

  secret      = google_secret_manager_secret.srt_passphrase[each.key].id
  secret_data = random_password.srt_passphrase[each.key].result
}

resource "google_secret_manager_secret" "postgres" {
  for_each = var.stages

  project   = var.project_id
  secret_id = "${var.name_prefix}-postgres-password-${each.key}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "postgres" {
  for_each = var.stages

  secret      = google_secret_manager_secret.postgres[each.key].id
  secret_data = random_password.postgres[each.key].result
}

resource "google_secret_manager_secret" "grafana_admin" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-grafana-admin"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "grafana_admin" {
  secret      = google_secret_manager_secret.grafana_admin.id
  secret_data = random_password.grafana_admin.result
}
