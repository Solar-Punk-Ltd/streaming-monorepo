import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../domain/Logger.js';

const logger = Logger.getInstance();

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  // Method, URL and status only, never a body or a header: bodies here carry
  // passwords and session cookies. The query strings the console sends are a
  // bulk id and a thumbnail's cache-busting timestamp, safe to log.
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}
