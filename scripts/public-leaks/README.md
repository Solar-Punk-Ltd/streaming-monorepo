# Public leak gate

This repository is public, and anything in it that points at one real deployment, an address, a
domain, a wallet or a host name, can be found and used by whoever reads it. The same holds for a
secret, a person's home folder or a personal email address. This gate reads every file git tracks
and fails when it finds one of these.

| Rule                | Fails on                                                                                                        | Lets through                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipv4`              | an IPv4 address in public space                                                                                 | the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), private, shared, loopback and link-local ranges, and 8.8.8.8 or 1.1.1.1        |
| `host-private-ipv4` | a private address in a range that describes one host's setup                                                    | every other private address, such as `10.0.0.7`, `172.17.0.1` or `192.168.1.20`                                                                          |
| `eth-address`       | an Ethereum address, `0x` and 40 hex digits                                                                     | the known fakes and public contracts in `allow.json`, each with the reason                                                                               |
| `denied-token`      | a token whose lowercase sha256 is in `deny.sha256`                                                              | everything else                                                                                                                                          |
| `private-key-block` | a PEM or PGP private key header, `-----BEGIN ... PRIVATE KEY-----`                                              | public keys and certificates                                                                                                                             |
| `aws-access-key`    | an AWS access key id, `AKIA` or `ASIA` and 16 more letters and digits                                           | the bare prefix in prose                                                                                                                                 |
| `github-token`      | a GitHub token, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` or `github_pat_` and its body                            | the bare prefix in prose                                                                                                                                 |
| `slack-token`       | a Slack token, `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-` or `xoxs-` and its body                                       | the bare prefix in prose                                                                                                                                 |
| `stripe-key`        | a Stripe secret or restricted key, live or test                                                                 | the bare prefix in prose                                                                                                                                 |
| `jwt`               | a JSON Web Token, two `eyJ` segments and a signature                                                            | a single `eyJ` segment                                                                                                                                   |
| `keyed-hex-64`      | 64 hex digits within 40 characters of `key`, `secret`, `private`, `seed`, `signer` or `wallet` on the same line | an image digest after `sha256:`, 64 hex digits with no such word near, and the published samples in `allow.json`                                         |
| `home-path`         | a home folder that names a person, `/Users/<name>/` or `/home/<name>/`                                          | the role users in `allow.json`, such as `bee` and `deploy`, each with the reason                                                                         |
| `email`             | an email address at a real-looking domain                                                                       | `example.com`, `example.net`, `example.org` and their subdomains, the reserved `.example`, `.invalid`, `.test` and `.localhost`, and the GitHub SSH user |

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
rule prints the file, the line and the token's length, never the token. Every rule except the three
address rules prints the same way, so the CI log never repeats a secret, a home folder or an email
address it caught.

A test that has to show a rule refusing something builds the value while it runs, from pieces that
do not match on their own, so the test file itself passes the gate.

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
A secret comes from the environment or a file the operator supplies. If a real secret was ever
committed, rotate it: removing it from the tree does not remove it from the history.

## Adding to a list

- An Ethereum address that is a public contract or an obvious test fixture goes in `allow.json`,
  lowercase, with the reason.
- A 64-hex value that is published on purpose, such as a well-known test account's key, goes in
  `allow.json` under `publishedSecrets` as the sha256 of its lowercase hex without `0x`, with the
  reason. Add the hash, never the value, and only for a value that is public already:

  ```sh
  printf '%s' '<64 hex digits in lowercase, no 0x>' | shasum -a 256 | cut -c1-64
  ```

- A role user whose home folder the tree names on purpose goes in `allow.json` under `homeUsers`,
  with the reason. A person's name never does: write `$HOME` or a path relative to the repository.
- A name that must never appear goes in `deny.sha256` as the sha256 of its lowercase form, one per
  line. Add the hash, never the name:

  ```sh
  printf '%s' '<name in lowercase>' | shasum -a 256 | cut -c1-64
  ```
