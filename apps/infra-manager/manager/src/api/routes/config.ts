import { configuredBeeRpcEndpoint } from '@streaming-infra-manager/common';
import { Request, Response, Router } from 'express';

import { Logger } from '../../domain/Logger.js';
import { resolveServerHost } from '../../utils/serverHost.js';

const logger = Logger.getInstance();

/**
 * The host-wide facts the frontend needs before it can render anything.
 *
 * `chequebookFloorBzz` is passed in rather than read here, so the number the UI
 * shows is provably the one the deploy gate's warning quotes. The passphrase comes
 * from whoever knows where the bundled stack runs, its legacy tree or its
 * current build, rather than from a fixed path.
 *
 * `beeRpcEndpoint` is the manager's own chain endpoint, BEE_RPC_ENDPOINT. The
 * wizard offers it first to every Bee node it creates, so a page has to know
 * whether there is one and which it is. Only its host travels: the URL itself
 * can carry an API key, and this answer goes to every signed-in browser.
 *
 * `instanceName` is the name this manager instance goes by, MANAGER_INSTANCE_NAME, or null when none is set. The
 * sidebar shows it beside the build the manager runs.
 */
export function createConfigRouter(
  chequebookFloorBzz: string,
  hostPassphrase: () => Promise<string | null>,
  beeRpcEndpoint: string | null,
  instanceName: string | null,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next) => {
    try {
      const host = resolveServerHost();
      const srtPassphrase = await hostPassphrase();
      logger.info(`[config] GET /config → host=${host}`);
      res.json({
        host,
        srtPassphrase,
        chequebookFloorBzz,
        beeRpcEndpoint: configuredBeeRpcEndpoint(beeRpcEndpoint),
        instanceName,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
