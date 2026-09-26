terraform {
  # Same bucket as the GCP root, different prefix: one place to guard, two states.
  #   terraform init -backend-config=envs/poc.backend.hcl
  #
  # Partial configuration for the same reason as ../backend.tf: the bucket comes from
  # ../bootstrap/ and is supplied at init time, so the state location is never a code change.
  backend "gcs" {}
}
