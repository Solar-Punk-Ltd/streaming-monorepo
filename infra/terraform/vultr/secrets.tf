# The manager's Postgres password, one per host — a manager per host means a Postgres per host,
# and a shared password would make a compromised host a compromised fleet.
#
# special = false for the same reason as ../secrets.tf: this value travels through an env file
# and is embedded in a DATABASE_URL, where shell metacharacters and percent-encoding are a
# source of silent breakage.
#
# THE DIFFERENCE FROM THE GCP ROOT: there is no Secret Manager here, and no Vultr equivalent
# worth pretending is one. The password exists in exactly two places — this root's Terraform
# state, and the rendered rendered/vultr/<key>/manager.env (0600, gitignored) that an operator
# scps to the host. So the state bucket is not just "a" boundary, it is the ONLY one: whoever can
# read gs://<gcp_state_bucket>/vultr/ can read this password. That bucket's project IAM, decided
# outside both roots, is what the claim rests on — ../README.md's note on choosing a project
# whose IAM the team controls applies to this root unchanged.
#
# It is a low-value secret by design: Postgres is published on 127.0.0.1:5432 only (the manager's
# compose file), so reaching it already requires being on the host.
resource "random_password" "postgres" {
  for_each = var.bee_hosts

  length  = 32
  special = false
}
