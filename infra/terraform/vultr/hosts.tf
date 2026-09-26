# One ssh key object for the whole root, not one per host: Vultr installs a registered key into
# the default user's authorized_keys at deploy time, and the same key reaches the GCP hosts, so
# there is one credential and one place to rotate it. Rotating it does NOT reach a running host —
# ssh_key_ids is ForceNew on the instance (see below), so a rotation is a deliberate rebuild or a
# manual authorized_keys edit, never a side effect of an apply.
resource "vultr_ssh_key" "bee" {
  name    = "${var.name_prefix}-bee"
  ssh_key = var.ssh_public_key
}

# The reserved IP is this host's identity in four places at once: the /32 a GCP stage firewall
# rule admits, the /32 the GCP root's Loki push rule admits, PUBLIC_HOST in manager/.env (from
# which the manager composes every rung's BEE_PUBLISHERS URL) and BEE_UPLOADER_NAT_ADDR, which
# each Bee node advertises to the Swarm network. An address that changed on rebuild would break
# all four silently, and two of them are edited by hand in another system.
#
# Its own resource rather than the instance's ephemeral main_ip precisely so it outlives the
# instance: `-replace` on the instance keeps the address, which is what makes a rebuild a
# one-command recovery instead of a re-allowlisting exercise across two clouds.
resource "vultr_reserved_ip" "bee" {
  for_each = var.bee_hosts

  region  = each.value.region
  ip_type = "v4"
  label   = local.host_names[each.key]

  # Attached from the instance side (vultr_instance.reserved_ip_id), never from here: setting
  # instance_id here as well would give the same attachment two owners in the graph, and each
  # apply would fight the other. The provider supports both spellings; this root uses exactly one.
}

# First-boot provisioning as a Vultr startup script rather than as the instance's user_data,
# which is a deliberate choice and the one place this root's shape differs from ../stages.tf.
#
# At runtime the two are equivalent: Vultr's metadata service hands user-data to cloud-init and
# hands a startup script through vendor-data, and cloud-init runs both cc_scripts_user and
# cc_scripts_vendor at PER_INSTANCE frequency — so either way the script runs once per instance
# and NOT on every reboot.
#
# In the provider they are not equivalent at all. `vultr_instance.user_data` is ForceNew, so
# editing templates/bee_provision.sh.tftpl — or bumping the Alloy digest, or the monitoring host
# getting a new address — would destroy and recreate the host, and with it every Bee wallet, key
# and postage batch on its disk. `vultr_startup_script.script` is not ForceNew and the instance's
# `script_id` does not change when the content does, so the same edit is an in-place update to an
# account-level object and the running host is untouched. That is the GCP root's behaviour
# (a metadata update that takes effect on the next boot) reproduced on a provider that does not
# offer it directly.
#
# What it does NOT reproduce: there is no `google_metadata_script_runner` here, and the script is
# per-instance, so a reboot does not re-run it either. The way to apply an edit to a live host is
# the rendered copy in rendered/vultr/<key>/provision.sh — see render.tf and the README.
resource "vultr_startup_script" "bee" {
  for_each = var.bee_hosts

  name = "${local.host_names[each.key]}-provision"
  type = "boot"

  # The API takes it base64-encoded (the provider validates that, and unlike user_data does not
  # encode it for us). Same string as the rendered provision.sh, from one local, so the file an
  # operator re-runs by hand cannot drift from the one a rebuild uses.
  script = base64encode(local.provision_scripts[each.key])
}

locals {
  provision_scripts = { for key, host in var.bee_hosts : key => templatefile("${path.module}/templates/bee_provision.sh.tftpl", {
    host_user         = local.host_user
    manager_repo_path = local.manager_repo_path
    bee_data_root     = local.bee_data_root

    # solarpunk's authorized_keys roster: the deploy key Vultr installed for root, plus the
    # manager host's. Written by Terraform rather than copied from root so the roster is in
    # tfvars and a re-run converges a running host to it.
    ssh_public_key             = var.ssh_public_key
    additional_ssh_public_keys = var.additional_ssh_public_keys

    # The shared fragment, rendered from the GCP root's templates directory rather than copied:
    # two copies of an Alloy config in two roots is a drift waiting to happen, and only the
    # labels differ. role/stage/host carry exactly the values the Prometheus targets do (see
    # render.tf), which is what lets a log line and a metric be lined up by host.
    #
    # loki_url is the monitoring host's EXTERNAL address, where the GCP root's own hosts use its
    # internal one: there is no shared network between the clouds, so this push crosses the
    # public internet in cleartext — Loki has no authentication either. What stands in front of
    # it is the GCP root's loki_push_external rule, keyed on exactly these reserved /32s. That is
    # why bee_host_ips is an output and why the README's step 2 is not optional.
    alloy_provision = templatefile("${path.module}/../templates/alloy_provision.sh.tftpl", {
      alloy_dir   = local.alloy_dir
      alloy_image = local.alloy_image
      host_name   = local.host_names[key]
      role        = "bee"
      stage       = key
      loki_url    = "http://${local.gcp_monitoring_ip}:${local.loki_port}/loki/api/v1/push"
    })
  }) }
}

resource "vultr_instance" "bee" {
  for_each = var.bee_hosts

  region = each.value.region
  plan   = each.value.plan
  os_id  = var.os_id

  # hostname is what the guest calls itself and what appears in the Vultr console; label is the
  # account-level display name. Same string for both, and the same string as the Prometheus
  # instance_name label, so one name identifies the host in the console, in a shell prompt, in a
  # dashboard and in a Loki query.
  hostname = local.host_names[each.key]
  label    = local.host_names[each.key]

  # Vultr tags are flat strings on the account, so they are the only grouping there is for
  # filtering the console and the billing view. The prefix tag is what isolates this workload
  # from anything else on the account, the same job ../providers.tf's default_labels do on GCP.
  tags = [var.name_prefix, "bee", each.key]

  ssh_key_ids       = [vultr_ssh_key.bee.id]
  firewall_group_id = vultr_firewall_group.bee.id
  script_id         = vultr_startup_script.bee[each.key].id

  # The address this host is known by everywhere else. Attached at deploy so it is the instance's
  # main IP from first boot, which matters for two things that read the interface rather than a
  # config file: apt during provisioning, and the manager's deploy.sh, which derives PUBLIC_HOST
  # from the default route's source address.
  reserved_ip_id = vultr_reserved_ip.bee[each.key].id

  # v4 only. Every rule in the firewall group is ip_type v4, and whether a group with no v6 rules
  # denies v6 inbound or leaves it unfiltered is not something Vultr documents — so the host is
  # not given a v6 address to be wrong about. Bee's libp2p listener would happily bind it, and a
  # publicly reachable, unfiltered Bee API is exactly the thing the API band rule exists to
  # prevent.
  enable_ipv6 = false

  # No mail per deploy: a rebuild is a routine operation here, and the address in the account is
  # a shared one.
  activation_email = false

  # Both are billable extras and neither buys anything for this workload. Backups: a snapshot of
  # a Bee data root is a snapshot of chunk stores and a wallet mid-write, which is not a
  # recovery story — the recovery story is the README's "back up the data root before -replace".
  # DDoS protection is a per-instance monthly charge and the exposed surface is already narrowed
  # to a P2P port that is supposed to be public.
  backups         = "disabled"
  ddos_protection = false

  # Vultr's default. Stated rather than inherited because the provisioning script depends on it:
  # user_scheme = "root" is what makes Vultr install the ssh key into /root/.ssh/authorized_keys,
  # which templates/bee_provision.sh.tftpl copies to solarpunk. "limited" would create a
  # `linuxuser` instead and the copy step would find nothing. It is ForceNew, so this is not a
  # setting to discover later.
  user_scheme = "root"

  lifecycle {
    # Deliberately false, and deliberately written down. prevent_destroy = true would read as
    # protection for the Bee wallets on this disk, but it also blocks `-replace`, which IS the
    # rebuild procedure in the README, and blocks a real teardown at the end of the event — so it
    # would trade a routine operation for a code edit under time pressure.
    #
    # What actually protects the disk is knowing which arguments are ForceNew in this provider,
    # because each of them destroys the instance and every Bee wallet, key and postage batch on
    # it. As of vultr/vultr 2.32.0 that is: region, os_id, hostname, ssh_key_ids, reserved_ip_id,
    # script_id, user_scheme, snapshot_id, user_data. Read a plan before applying it and treat
    # any "must be replaced" on this resource as a data-loss event that needs the data root
    # backed up first.
    #
    # os_id in particular is NOT in ignore_changes, although a change to it reinstalls the OS.
    # The GCP root ignores its boot image because a data source floats it and Ubuntu publishing
    # an image would replace a running stage; here os_id is a literal from .tfvars that cannot
    # drift on its own, so there is nothing to absorb — and ignoring it would hide the single
    # most destructive edit in this file behind a silent no-op.
    prevent_destroy = false
  }

  # plan is the one sizing argument that is NOT ForceNew: the provider sends an upgrade request
  # and waits for the plan to change, so resizing keeps the disk and the address. Two caveats
  # that belong in the plan review and not in a surprise: Vultr resizes are one-way (a smaller
  # plan is not offered, so an edit in that direction fails rather than shrinking the host), and
  # the resize reboots the instance — which the Bee nodes survive, since compose brings them back
  # with `restart: unless-stopped`.
}
