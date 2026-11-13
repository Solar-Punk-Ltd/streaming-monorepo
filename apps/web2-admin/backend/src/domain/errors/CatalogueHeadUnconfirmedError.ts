/**
 * Why the catalogue's latest entry could not be confirmed: the catalogue node has no peers, the feed holds an entry
 * past the one the node's lookup found, or the node did not answer whether it does.
 */
export type CatalogueHeadProblem = 'no_peers' | 'gap' | 'unanswered';

const SENTENCES: Readonly<Record<CatalogueHeadProblem, string>> = {
  no_peers:
    "The catalogue node has no peers, so the catalogue's latest entry cannot be confirmed. Nothing was written. Check the catalogue node's connection and try again.",
  gap: "The catalogue's feed has entries past the one the node found as its latest, so its latest entry cannot be confirmed. Nothing was written.",
  unanswered:
    'The catalogue node did not answer whether the catalogue has newer entries, so its latest entry cannot be confirmed. Nothing was written. Try again.',
};

/**
 * A write to the catalogue was refused because the admin has no write of its own recorded for the feed and could not
 * confirm the latest entry the network holds, so it cannot tell which index is free. `message` is the sentence the
 * console and the log show; it names no node.
 *
 * Thrown before anything is written to the feed. A publish, an unpublish or a republish records it as the stream's
 * publish error, as it records any failed write; a reconcile answers it as its own 503.
 */
export class CatalogueHeadUnconfirmedError extends Error {
  constructor(public readonly problem: CatalogueHeadProblem) {
    super(SENTENCES[problem]);
    this.name = 'CatalogueHeadUnconfirmedError';
  }
}
