# TypeScript linting

Status: active. Focused changed-file lint and the negative control were verified
2026-09-20 on commit `e72850a`. The full `pnpm lint`, typecheck, and unit run on
the verification box is pending GitHub signing through 1Password.

Run the repository lint from the root:

```sh
pnpm lint
```

The root command runs each workspace package's real ESLint script. The shared
flat config enables the ESLint recommended rules and the typed
`typescript-eslint` recommended rules. Warnings fail the command.

`@typescript-eslint/no-floating-promises` remains enabled in tests. Calls to
the test registration functions exported by `node:test`, such as `test` and
`describe`, are the only known-safe promise exception. An unawaited
`assert.rejects(...)` remains an error. `require-await` is disabled only for
`web2-admin/backend/test/unit/support/fakes.ts`, where async methods implement
production interfaces whose methods return promises.

The setup was checked with a temporary negative-control file. An ordinary
`node:test` declaration passed while an unawaited `assert.rejects(...)` failed
with `@typescript-eslint/no-floating-promises`. The bad file was not retained.

## Dependency evidence

All versions are pinned in `package.json` or `pnpm-lock.yaml`. The checks below
were collected on 2026-09-20.

| Dependency | Published | Registry signature | Provenance | Malware result |
| --- | --- | --- | --- | --- |
| `eslint@9.39.1` | 2025-11-03 | present | absent | no matching advisory |
| `@eslint/js@9.39.1` | 2025-11-03 | present | absent | no matching advisory |
| `typescript-eslint@8.48.1` | 2025-12-02 | present | present | no matching advisory |
| `brace-expansion@1.1.18` override | 2026-07-30 | present | absent | no matching advisory |
| `brace-expansion@2.1.4` override | 2026-07-30 | present | absent | no matching advisory |

The lockfile introduced 45 resolved versions. Every introduced version was
more than 14 days old and had a registry signature. Installed-tree signature
verification reported 501 signed packages and 153 provenance attestations.
The introduced packages without provenance attestations are:

- `@eslint/js@9.39.1`
- `@humanfs/core@0.19.2`
- `@humanfs/node@0.16.8`
- `@humanfs/types@0.15.0`
- `@humanwhocodes/module-importer@1.0.1`
- `@humanwhocodes/retry@0.4.3`
- `@types/json-schema@7.0.15`
- `acorn-jsx@5.3.2`
- `acorn@8.18.0`
- `ajv@6.15.0`
- `argparse@2.0.1`
- `balanced-match@1.0.2`
- `brace-expansion@1.1.18`
- `brace-expansion@2.1.4`
- `chalk@4.1.2`
- `concat-map@0.0.1`
- `cross-spawn@7.0.6`
- `deep-is@0.1.4`
- `eslint@9.39.1`
- `type-check@0.4.0`
- `uri-js@4.4.1`
- `which@2.0.2`
- `word-wrap@1.2.5`
- `yocto-queue@0.1.0`

The malware query for `chalk` returned GHSA-2v46-p5h4-248w. Its affected range
is exactly `5.6.1`, so the installed `4.1.2` is outside the affected range.
Neither `pnpm audit` nor the malware checks identified an introduced lint
package at an affected version. Existing findings outside this lint change
remain visible in the repository audit and are not reclassified by this setup.
