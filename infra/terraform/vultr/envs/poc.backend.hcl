# Committed on purpose, exactly as ../../envs/poc.backend.hcl is: a bucket name is not a secret,
# and copying an example file is a per-checkout manual step of the kind M4 exists to eliminate.
# ../../bootstrap/ creates this bucket; the prefix is the only thing that differs from the GCP
# root, so the two states never share a lock or a version history.
bucket = "streaming-504704-devcon-tfstate"
prefix = "vultr"
