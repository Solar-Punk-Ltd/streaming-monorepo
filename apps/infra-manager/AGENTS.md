# AGENTS.md

This file is read by AI coding agents working in this repository. It describes where this
repository keeps its issues, its decisions and its reference documentation. Edit it directly when
those conventions change.

## Issues and decisions

The manager keeps no issue files, review records or decision logs in the tree. Records of finished
work are read from the repository's history, and new work does not add records of that kind here.
Current problems belong in the repository's `docs/known-issues.md`, and planned work in
`docs/ROADMAP.md`.

`.scratch/` is gitignored and local to one machine. Working notes kept there are not a source
anything in the repository can cite.

## Reference documentation

This repository has no `CONTEXT.md` and no `docs/adr/`. Domain vocabulary and design reasons live
in the pages that describe the feature they belong to:

- `README.md`: what the manager is, how to run it, its layout and the list of documents.
- `manager/README.md`: the API and settings reference. `managerEnvKeyDocs.test.ts` holds it to
  naming every environment variable the manager reads.
- `deploy/README.md`: the deploy guide, from server setup to opening the manager to the internet.
  `stackBindKeyDocs.test.ts` holds it to naming every bind key the stack ships.
- `docs/console.md`: the console's pages, the readiness checklist and the wizard.
- `docs/features/`: one present-tense page per feature: what it does, how to use it, its settings
  and routes, and its limits.
- `docs/ci.md`: what the two workflows run, the pins, and how to run the same checks locally.
  `srsImagePin.test.ts` reads its image pin table.
- `manager/test/integration/README.md`: the signed-in integration suite.

The pages describe the software as it is, in the present tense, without dates or build history.
When you change behaviour, change the page that describes it in the same branch.
