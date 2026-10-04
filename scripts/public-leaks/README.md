# Public leak gate

This repository is public, and anything in it that points at one real deployment, an address, a
domain, a wallet or a host name, can be found and used by whoever reads it. This gate reads every
file git tracks and fails when it finds one of four things.

| Rule                | Fails on                                                     | Lets through                                                                                                                                      |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipv4`              | an IPv4 address in public space                              | the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), private, shared, loopback and link-local ranges, and 8.8.8.8 or 1.1.1.1 |
| `host-private-ipv4` | a private address in a range that describes one host's setup | every other private address, such as `10.0.0.7`, `172.17.0.1` or `192.168.1.20`                                                                   |
| `eth-address`       | an Ethereum address, `0x` and 40 hex digits                  | the known fakes and public contracts in `allow.json`, each with the reason                                                                        |
| `denied-token`      | a token whose lowercase sha256 is in `deny.sha256`           | everything else                                                                                                                                   |

Most private addresses are neutral: a container default or a fixture means the same thing on every
machine. A few ranges are not, because an address in one of them only exists on the host that was set
up that way. `HOST_SPECIFIC_PRIVATE_RANGES` in `lib.mjs` lists them by hand, written as octets so the
gate's own source passes:

| Range                 | Why it describes one host                               |
| --------------------- | ------------------------------------------------------- |
| `10.200.x.x`, a /16   | a custom Docker address pool chosen for one host        |
| `192.168.65.x`, a /24 | the virtual machine range of Docker Desktop on a laptop |

Add a range there, with the reason, when another one turns up. Write the address the code should reach
as a setting with a documented default instead.

`deny.sha256` holds hashes only, so the file names nothing it refuses. A token is a run of letters,
digits, dots, hyphens, underscores and at signs, and every contiguous piece of it, so a denied host
name is found inside `user@host` and a denied domain inside any of its subdomains. A finding of this
rule prints the file, the line and the token's length, never the token.

```sh
node scripts/public-leaks/gate.mjs
```

```sh
node --test scripts/public-leaks/test/gate.test.mjs
```

The gate exits 0 when it finds nothing, 1 with findings and 2 when it could not run. The boundaries
workflow runs both on every pull request.

## When it fails

Replace the value with a placeholder: a documentation address, `example.com` or `example.org`, a host
named by its role, a clearly fake address. What differs between hosts is a setting, never a literal.

## Adding to a list

- An Ethereum address that is a public contract or an obvious test fixture goes in `allow.json`,
  lowercase, with the reason.
- A name that must never appear goes in `deny.sha256` as the sha256 of its lowercase form, one per
  line. Add the hash, never the name:

  ```sh
  printf '%s' '<name in lowercase>' | shasum -a 256 | cut -c1-64
  ```
