# Roadmap

This page says what the platform does today and what comes next. Current problems are in
[known-issues.md](known-issues.md).

## Today

- A brand's users sign in to the admin, create streams, pick the stage each goes live on, and copy
  the SRT settings into OBS or another encoder.
- The stack takes the broadcast in, transcodes it into a ladder of qualities, and writes every
  segment and playlist to Swarm as it happens. Recordings stay on Swarm after the broadcast, for as long as their postage lasts.
- The viewer lists the brand's streams from the catalogue on Swarm and plays them from a Bee gateway
  or from a light node in the browser tab.
- The manager deploys the stack and its Bee nodes onto hosts, buys postage, and tells the admin about
  every stage it runs.
- The brand funds its nodes, tops up and dilutes its stamps and fills its chequebooks from the
  admin's brand wallet.
- Every release is a git tag, and each console shows the release it runs.

## Next

- A branding editor in the admin, for the brand's theme and logo.
- The player takes its branding from the admin: theme, logo, stream list, gateway list and domain.
- The admin shows a broadcast whose quality ladder never started, instead of showing it as published.
- RTMP returns to the admin's encoder settings beside SRT.
- The catalogue can move to a new postage batch on every installation, once the move is proven on a
  real node.
- The admin's Stages page counts stage retirements still waiting to reach it.

## Later

- One encoder per stream: per-user publish keys, a warning when encoders fight over one stream, and
  a takeover that only replaces a silent encoder.
- A key rotation that also ends a broadcast already live on the old key.
- Audio as its own rendition in the ladder, instead of muxed into every quality.
- Several brands in one admin, each with its own stages, and a second admin link per manager.
- More ways to sign in to the admin, such as OIDC, a wallet signature or a magic link.
- Chat beside each stream in the player.
- A recipe for running the release images published to the container registry.
