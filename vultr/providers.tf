# The API key comes from the environment and from nowhere else:
#
#   export VULTR_API_KEY=...    # my.vultr.com/settings/#settingsapi
#
# Never a variable and never in envs/poc.tfvars. A Vultr API key is account-wide and has no
# resource scoping — it can destroy every instance on the account — so it must not be able to
# reach a committed file by accident, and it must not land in the state or in a plan file the way
# a var-set value does. Vultr's own API access-control list (an allowlist of source addresses on
# the key itself) is the second half of this; terraform/vultr/README.md says to turn it on.
provider "vultr" {}
