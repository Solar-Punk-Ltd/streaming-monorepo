terraform {
  # 1.9 is not a round number: the cross-variable references in variables.tf's
  # ladders_per_host validation (it reads var.rungs_per_ladder) are a 1.9 feature. On 1.8 the
  # slot budget would silently stop being checked.
  required_version = ">= 1.9"

  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.32"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # No hashicorp/google here although the state lives in a GCS bucket and data.tf reads the GCP
  # root's outputs from another one. Both are backend concerns: the gcs backend and
  # terraform_remote_state's gcs backend authenticate through Application Default Credentials (or
  # GOOGLE_OAUTH_ACCESS_TOKEN) on their own, without a configured provider. Declaring the google
  # provider here would add a second credential path and a second version constraint to keep in
  # step with ../versions.tf for no gain.
}
