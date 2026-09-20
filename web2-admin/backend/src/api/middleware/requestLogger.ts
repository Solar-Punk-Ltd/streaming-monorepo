import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../domain/Logger.js';

const logger = Logger.getInstance();

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();
  // Method, path and status only. Bodies carry passwords and session cookies,
  // while internal recovery queries carry uploader and claim identities.
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(
      `[HTTP] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`,
    );
  });
  next();
}
