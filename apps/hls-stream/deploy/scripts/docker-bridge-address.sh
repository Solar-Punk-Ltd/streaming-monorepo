#!/bin/sh
# Prints the address the stack's admin and file interfaces are bound to wherever their own setting is
# empty: the gateway of Docker's default bridge network on this host. Prints nothing and exits 1 when
# the daemon could not be asked or reported no IPv4 gateway.
#
# Containers on this host reach the host at that address, through host.docker.internal, and nothing
# outside the host does. That is the one part of a port's exposure a firewall cannot decide, because
# Docker publishes a port with rules of its own that a host firewall such as ufw never sees, and a Bee
# API has no password and can spend money.
#
# Docker Desktop runs the daemon inside a virtual machine whose bridge the host itself cannot reach,
# and forwards ports published on the loopback address to the host, so there the answer is 127.0.0.1.
#
# Plain POSIX sh, because deploy.sh pipes this file to the login shell of a remote deployment host.

os=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)
if [ "$os" = "Docker Desktop" ]; then
  echo 127.0.0.1
  exit 0
fi

for gateway in $(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null); do
  case "$gateway" in
    *[!0-9.]* | *..* | .* | *.) continue ;;
  esac
  case "$gateway" in
    *.*.*.*.*) continue ;;
    *.*.*.*)
      echo "$gateway"
      exit 0
      ;;
  esac
done
exit 1
