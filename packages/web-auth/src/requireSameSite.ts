import type { NextFunction, Request, Response } from 'express';

import { CrossSiteRequestError } from './errors/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

const CROSS_SITE = 'cross-site';

/** What a request says about where it came from. */
export interface RequestOrigin {
  method: string;
  /** The `Host` the request was addressed to. */
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  requestedWith: string | undefined;
}

/** The header an app's own pages put on every write, and the value only they send. */
export interface RequestedWith {
  header: string;
  value: string;
}

export interface SameSiteGate {
  /** Why this request must be refused as cross-site, or null when it may proceed. */
  crossSiteReason(request: RequestOrigin): string | null;
  /** The middleware: passes a CrossSiteRequestError on for a refused request. */
  requireSameSite(req: Request, res: Response, next: NextFunction): void;
}

/**
 * Compared by host and not by full origin: behind a TLS edge the browser speaks
 * https while the backend is reached over http, so the schemes never match
 * while the host always does.
 */
function isOwnOrigin(request: RequestOrigin): boolean {
  if (!request.host) return false;
  try {
    return new URL(request.origin ?? '').host === request.host;
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The cross-site gate for one app, which names its own header value.
 *
 * Three layers, all cheap. `SameSite=Lax` on the cookie is the first and is not
 * here. These are the other two and a half: the browser's own verdict in
 * `Sec-Fetch-Site`, the `Origin` host against the `Host` asked for, and a header
 * no cross-origin page can add without a CORS preflight the API never answers.
 *
 * Reads on purpose are never refused: they change nothing, a live update stream
 * is a read that `EventSource` opens with no headers of its own, and an image
 * has to open in a tab of its own.
 */
export function createSameSiteGate(requestedWith: RequestedWith): SameSiteGate {
  function crossSiteReason(request: RequestOrigin): string | null {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

    if (request.secFetchSite?.toLowerCase() === CROSS_SITE) {
      return 'the browser reported Sec-Fetch-Site: cross-site';
    }

    if (request.origin !== undefined && !isOwnOrigin(request)) {
      return 'the Origin header names another site';
    }

    if (request.requestedWith !== requestedWith.value) {
      return `a write needs the ${requestedWith.header} header`;
    }

    return null;
  }

  function requireSameSite(req: Request, _res: Response, next: NextFunction): void {
    const reason = crossSiteReason({
      method: req.method,
      host: req.headers.host,
      origin: headerValue(req.headers.origin),
      secFetchSite: headerValue(req.headers['sec-fetch-site']),
      requestedWith: headerValue(req.headers[requestedWith.header]),
    });

    next(reason ? new CrossSiteRequestError(reason) : undefined);
  }

  return { crossSiteReason, requireSameSite };
}
