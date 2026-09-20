import { Router } from 'express';

import type { ManagedIngestLifecycleConfig } from '../../utils/managedIngestConfig.js';

export function createInternalRuntimeRouter(
  config: ManagedIngestLifecycleConfig | null,
): Router {
  const router = Router();
  router.get('/runtime/lifecycle', (_req, res) => {
    res.json(
      config === null
        ? { lifecycleVersion: null, uploaderId: null }
        : { lifecycleVersion: config.lifecycleVersion, uploaderId: config.uploaderId },
    );
  });
  return router;
}
