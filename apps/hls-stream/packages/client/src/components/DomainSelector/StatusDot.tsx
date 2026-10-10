import { type SourceStatus, sourceStatusWords, UNCHECKED } from './sourceStatus';

/** A source's light check at a glance: a dot whose colour is its health, and its time or state in words. */
export function StatusDot({ status = UNCHECKED }: { status?: SourceStatus }) {
  return (
    <span className={`source-status ${status.health}`} data-health={status.health}>
      <span className="source-status-dot" aria-hidden="true" />
      {sourceStatusWords(status)}
    </span>
  );
}
