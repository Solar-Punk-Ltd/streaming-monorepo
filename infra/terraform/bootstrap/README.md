Applied once, with local state, to create the versioned GCS bucket that holds the parent root's state.

`terraform init && terraform apply -var project_id=<project> -var state_bucket_name=<bucket>`

Then one directory up, once per checkout: `terraform init -backend-config=envs/poc.backend.hcl`

Put the bucket in a project whose IAM the team controls: through the parent root's state it holds
every password this configuration generates.

This root's state is local, so a checkout that does not have it does not know the bucket exists.
Adopt it rather than re-applying:

`terraform import google_storage_bucket.state <bucket-name>`

Or move this root's state into the bucket itself after M0 — a backend block plus
`terraform init -migrate-state` — and the problem goes away.
