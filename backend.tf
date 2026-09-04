terraform {
  # Partial configuration: the bucket comes from bootstrap/ and is supplied at init time,
  # so the state location is never a code change.
  #   terraform init -backend-config=envs/poc.backend.hcl
  backend "gcs" {}
}
