import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeContentChange, pnpmOwnFileName } from '../lib/pnpm-files.mjs';

/** A .modules.yaml as pnpm 9 writes it, in YAML. */
function modulesYaml({ packageManager = 'pnpm@9.12.0', prunedAt = 'Thu, 01 Jan 2026 00:00:00 GMT', hoisted = 'debug' } = {}) {
  return [
    'hoistPattern:',
    "  - '*'",
    'hoistedDependencies:',
    `  ${hoisted}@4.4.1:`,
    `    ${hoisted}: private`,
    'layoutVersion: 5',
    `packageManager: ${packageManager}`,
    `prunedAt: ${prunedAt}`,
    'storeDir: /root/.local/share/pnpm/store/v3',
    '',
  ].join('\n');
}

/** A .modules.yaml as pnpm 10 and 11 write it, in JSON despite its name. */
function modulesJson({ packageManager = 'pnpm@11.10.0', prunedAt = 'Thu, 01 Jan 2026 00:00:00 GMT', hoisted = 'debug' } = {}) {
  const modules = {
    hoistedDependencies: { [`${hoisted}@4.4.1`]: { [hoisted]: 'private' } },
    hoistPattern: ['*'],
    layoutVersion: 5,
    packageManager,
    prunedAt,
    storeDir: '/root/.local/share/pnpm/store/v11',
  };
  return `${JSON.stringify(modules, null, 2)}\n`;
}

function lockYaml({ lockfileVersion = "'9.0'", qs = '^6.16.0' } = {}) {
  return [`lockfileVersion: ${lockfileVersion}`, '', 'overrides:', `  qs: ${qs}`, '', 'importers:', '', '  .:', '    dependencies: {}', ''].join('\n');
}

describe('pnpmOwnFileName', () => {
  it("names each of pnpm's own files in the first node_modules folder of a path", () => {
    assert.equal(pnpmOwnFileName('app/node_modules/.modules.yaml'), '.modules.yaml');
    assert.equal(pnpmOwnFileName('node_modules/.pnpm/lock.yaml'), '.pnpm/lock.yaml');
    assert.equal(pnpmOwnFileName('runtime/node_modules/.pnpm-workspace-state-v1.json'), '.pnpm-workspace-state-v1.json');
    assert.equal(pnpmOwnFileName('repo/manager/node_modules/.package-map.json'), '.package-map.json');
  });

  it("names nothing else, a package's own file of one of those names included", () => {
    const others = [
      'app/.modules.yaml',
      'app/node_modules',
      'app/node_modules/demo/.modules.yaml',
      'app/node_modules/.pnpm/demo@1.0.0/node_modules/demo/node_modules/.modules.yaml',
      'app/node_modules/.pnpm/lock.yaml.bak',
      'app/node_modules/.pnpm-workspace-state-v2.json',
    ];
    for (const path of others) assert.equal(pnpmOwnFileName(path), null, path);
  });
});

describe('describeContentChange', () => {
  it('says a file differs in its install time only when the stamp pnpm rewrites on every install is all that moved', () => {
    const laterYaml = modulesYaml({ prunedAt: 'Fri, 02 Jan 2026 00:00:00 GMT' });
    assert.deepEqual(describeContentChange('.modules.yaml', modulesYaml(), laterYaml), { parts: ['its install time only: prunedAt'], installTimeOnly: true });

    const laterJson = modulesJson({ prunedAt: 'Fri, 02 Jan 2026 00:00:00 GMT' });
    assert.deepEqual(describeContentChange('.modules.yaml', modulesJson(), laterJson), { parts: ['its install time only: prunedAt'], installTimeOnly: true });

    const state = (time) => `${JSON.stringify({ lastValidatedTimestamp: time, projects: {}, settings: { dev: true } })}\n`;
    assert.deepEqual(describeContentChange('.pnpm-workspace-state-v1.json', state(1), state(2)), {
      parts: ['its install time only: lastValidatedTimestamp'],
      installTimeOnly: true,
    });
  });

  it('names the pnpm that wrote each side and the change of format, so a pnpm version change reads as one', () => {
    const change = describeContentChange('.modules.yaml', modulesYaml(), modulesJson());
    assert.deepEqual(change, { parts: ['written by pnpm@9.12.0 -> pnpm@11.10.0', 'as YAML -> JSON'], installTimeOnly: false });
  });

  it('names every top-level key that differs beyond the install time, in either format', () => {
    const json = describeContentChange('.modules.yaml', modulesJson(), modulesJson({ hoisted: 'ms', prunedAt: 'Fri, 02 Jan 2026 00:00:00 GMT' }));
    assert.deepEqual(json, { parts: ['in hoistedDependencies, prunedAt'], installTimeOnly: false });

    const yaml = describeContentChange('.modules.yaml', modulesYaml(), modulesYaml({ packageManager: 'pnpm@9.15.9' }));
    assert.deepEqual(yaml, { parts: ['written by pnpm@9.12.0 -> pnpm@9.15.9', 'in packageManager'], installTimeOnly: false });

    const lock = describeContentChange('.pnpm/lock.yaml', lockYaml(), lockYaml({ qs: '^6.15.2' }));
    assert.deepEqual(lock, { parts: ['in overrides'], installTimeOnly: false });
  });

  it('counts a stamp only for the file pnpm writes it in', () => {
    const lock = describeContentChange('.pnpm/lock.yaml', `${lockYaml()}prunedAt: 1\n`, `${lockYaml()}prunedAt: 2\n`);
    assert.deepEqual(lock, { parts: ['in prunedAt'], installTimeOnly: false });
  });

  it('says so when the text differs and no key does', () => {
    const compact = `${JSON.stringify({ layoutVersion: 5 })}\n`;
    const indented = `${JSON.stringify({ layoutVersion: 5 }, null, 2)}\n`;
    assert.deepEqual(describeContentChange('.package-map.json', compact, indented), { parts: ['in its formatting alone'], installTimeOnly: false });
  });
});
