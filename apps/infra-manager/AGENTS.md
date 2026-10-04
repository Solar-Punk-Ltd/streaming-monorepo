# AGENTS.md

This file is read by AI coding agents working in this repository. It describes where this
repository keeps its issues, its decisions and its reference documentation. Edit it directly when
those conventions change.

## Issues and decisions

The review that produced the main-v2 remediation, with its issue files, briefs, fixes files and
draft pull request bodies, and the dated narrative of that remediation, were kept under `docs/`
until 2026-09-28. They were records of finished work, so they were taken out of the tree and are
read from the repository's history. New work does not add records of that kind here.

`.scratch/` is gitignored and local to one machine. Working notes kept there are not a source
anything in the repository can cite.

## Reference documentation

This repository has no `CONTEXT.md` and no `docs/adr/`. Domain vocabulary and architectural
reasoning live in the pages that describe the feature they belong to:

- `README.md` for the layout and the stack it bundles.
- `deploy/README.md` for putting the manager on a server and opening it to the internet.
- `manager/README.md` for the API, the authentication model and the environment.
- `docs/features/` for one page per feature.
- `docs/ci.md` for what the two workflows run and what they prove.
- `docs/testing/` for the test topology of individual remediation rows.

A statement in any of these carries the date and the commit it was true at. When you change
behaviour, change the page that describes it in the same branch.
