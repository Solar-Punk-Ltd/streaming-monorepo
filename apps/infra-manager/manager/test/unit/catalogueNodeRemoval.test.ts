/**
 * The designated catalogue node is not removed while it is designated: the web2 admin writes the brand's catalogue
 * through it, so its removal is refused before the deployment is claimed or any script runs.
 *
 * Unit test over the orchestrator harness, no database and no Docker. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('catalogue-node-removal-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
process.env.DATABASE_URL = 'postgres://unused';
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
  writeFileSync(join(root, '.env.example'), 'ENGINE=srs\n');
  mkdirSync(join(root, 'data'), { recursive: true });
});

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { CatalogueNodeRemovalError } = await import('../../src/domain/errors/index.js');

function setup(designated: string | null) {
  const node = makeProfile({
    name: 'catalogue',
    kind: 'custom',
    components: ['bee-uploader'],
    instance_id: randomUUID(),
    status: 'RUNNING',
  });
  const h = orchestratorHarness([node]);
  h.orchestrator.setRemovalGuard(async (name) => {
    if (name === designated) throw new CatalogueNodeRemovalError(name);
  });
  return { ...h, node };
}

it('refuses to remove the designated catalogue node, and claims nothing', async () => {
  const h = setup('catalogue');
  await assert.rejects(
    h.orchestrator.startRemove(h.node),
    (err: unknown) =>
      err instanceof CatalogueNodeRemovalError &&
      /Clear the designation on the Manager settings page before removing it\./.test(err.message),
  );
  assert.equal(h.runner.runs.length, 0);
  assert.equal(h.profiles.rows.get('catalogue')!.status, 'RUNNING');
});

it('removes a Bee-only deployment that is not the catalogue node', async () => {
  const h = setup(null);
  await h.orchestrator.startRemove(h.node);
  assert.equal(h.runner.runs.length, 1);
});
