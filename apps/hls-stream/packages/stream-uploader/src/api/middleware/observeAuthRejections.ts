import { NextFunction, Request, RequestHandler, Response } from 'express';

const HTTP_UNAUTHORIZED = 401;

/** The generic push API's ingest routes, which a custom integration publishes through without an engine. */
const GENERIC_INGEST_ROUTES: readonly { method: string; path: string }[] = [
  { method: 'POST', path: '/stream/start' },
  { method: 'POST', path: '/stream/segment' },
];

interface AuthRejectionObserverOptions {
  /** Every mounted engine's prefix, such as `/engines/srs`. Everything below one is the ingest path. */
  enginePrefixes: readonly string[];
  /** A refusal on the ingest path, which is what `ingest_refused` is about. */
  onIngestRefused: () => void;
  /** A refusal anywhere else: `/metrics`, `/stream/status`, `/stream/stop`. */
  onOperatorRefused: () => void;
}

/**
 * Lowercased because express routes case-insensitively, so `/Engines/SRS/streams` reaches the SRS
 * router and its refusal is a refused publish like any other.
 */
function isIngestRequest(method: string, path: string, enginePrefixes: readonly string[]): boolean {
  const lowered = path.toLowerCase();
  const underEngine = enginePrefixes.some((prefix) => {
    const loweredPrefix = prefix.toLowerCase();
    return lowered === loweredPrefix || lowered.startsWith(`${loweredPrefix}/`);
  });
  if (underEngine) {
    return true;
  }
  return GENERIC_INGEST_ROUTES.some(
    (route) => route.method === method && (lowered === route.path || lowered === `${route.path}/`),
  );
}

/**
 * Counts every request a credential gate refused, wherever in the stack the refusal happens, and
 * says whether it was on the ingest path.
 *
 * Observed at the response rather than reported by each gate, because the gates do not share a
 * mounting point: `requireAuth` sits on `/stream` and `/metrics`, the SRS gate is mounted twice by
 * its own plugin, and OME signs the request body so its check cannot run until the body is parsed
 * and lives inside the router. That last one is the `on_publish` path, which is precisely the one
 * the refused-ingest health signal is about, so a wrapper around the mounted gates would have missed the case it was built for.
 *
 * Only an ingest refusal reaches `/health`. On 2026-10-15 one tokenless `GET /metrics`, which any
 * monitoring scraper sends, latched `ingest_refused` on the dev stage, because every 401 was counted
 * as a refused broadcaster. The path is read on the way in, before a mounted router strips its prefix.
 *
 * Mounted ahead of every gate, so the `finish` listener is attached before anything can answer 401.
 * `requestLogger` runs before it and only reads. Every 401 this service emits comes from a credential
 * gate: no route answers 401 for any other reason, and the rejection body is a fixed `Unauthorized`
 * that carries nothing about what was wrong.
 */
export function createAuthRejectionObserver(options: AuthRejectionObserverOptions): RequestHandler {
  const { enginePrefixes, onIngestRefused, onOperatorRefused } = options;
  return (req: Request, res: Response, next: NextFunction): void => {
    const ingest = isIngestRequest(req.method, req.path, enginePrefixes);
    res.on('finish', () => {
      if (res.statusCode !== HTTP_UNAUTHORIZED) {
        return;
      }
      if (ingest) {
        onIngestRefused();
      } else {
        onOperatorRefused();
      }
    });
    next();
  };
}
