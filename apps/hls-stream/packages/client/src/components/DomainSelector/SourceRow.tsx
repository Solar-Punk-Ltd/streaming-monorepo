import { useState } from 'react';

import { SOURCE_NAME_MAX_LENGTH, type Source } from '@/swarm/sources';

import { HelpSteps } from './HelpSteps';
import { CHECK_LABELS, type CheckResult } from './providerTest';
import { StatusDot } from './StatusDot';
import type { SourceStatus } from './sourceStatus';

/** A source's Test: running, or done with one result per check. */
export type SourceTest =
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly results: readonly CheckResult[] };

interface SourceRowProps {
  readonly source: Source;
  readonly isInUse: boolean;
  readonly isFallback: boolean;
  /** Whether a radio puts it in use, which is the case while every part reads from one source. */
  readonly canUse: boolean;
  readonly status?: SourceStatus;
  readonly test?: SourceTest;
  readonly onUse: () => void;
  readonly onTest: () => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}

/** Where a source is, as a viewer can recognise it: its host, or this site for a path such as `/bee`. */
function whereIs(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'this site';
  }
}

/**
 * One source in the node picker's list: a radio that puts it in use, its status dot, its name and where
 * it is, a Test with every result under it, and for a source the viewer added, rename and remove.
 */
export function SourceRow({
  source,
  isInUse,
  isFallback,
  canUse,
  status,
  test,
  onUse,
  onTest,
  onRename,
  onRemove,
}: SourceRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const isRunning = test?.state === 'running';

  return (
    <li className="gateway-tools-row" data-source-row={source.id}>
      <div className="gateway-tools-row-heading">
        {canUse && <input type="radio" checked={isInUse} onChange={onUse} aria-label={`Use ${source.name}`} />}
        <StatusDot status={status} />
        {draft === null ? (
          <span className="gateway-tools-name">{source.name}</span>
        ) : (
          <form
            className="gateway-tools-rename"
            onSubmit={(event) => {
              event.preventDefault();
              onRename(draft);
              setDraft(null);
            }}
          >
            <input
              className="gateway-tools-select"
              type="text"
              value={draft}
              maxLength={SOURCE_NAME_MAX_LENGTH}
              autoFocus
              aria-label={`New name for ${source.name}`}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="gateway-tools-button" type="submit">
              Save
            </button>
          </form>
        )}
        <span className="gateway-tools-where">
          {whereIs(source.url)}
          {isInUse && ', in use'}
          {!isInUse && isFallback && ', fallback'}
        </span>
        <button
          className="gateway-tools-button"
          onClick={onTest}
          disabled={isRunning}
          aria-label={`${isRunning ? 'Testing' : 'Test'} ${source.name}`}
        >
          {isRunning ? 'Testing...' : 'Test'}
        </button>
        {!source.offered && draft === null && (
          <>
            <button
              className="gateway-tools-button"
              onClick={() => setDraft(source.name)}
              aria-label={`Rename ${source.name}`}
            >
              Rename
            </button>
            <button className="gateway-tools-button" onClick={onRemove} aria-label={`Remove ${source.name}`}>
              Remove
            </button>
          </>
        )}
      </div>
      {isRunning && <p className="gateway-tools-note">Testing every feature...</p>}
      {test?.state === 'done' && (
        <ul className="gateway-tools-results" aria-label={`Test of ${source.name}`}>
          {test.results.map(({ check, outcome, sentence, help }) => (
            <li key={check} className={`gateway-tools-result ${outcome}`}>
              {CHECK_LABELS[check]}: {outcome === 'skipped' ? 'not tested' : outcome}. {sentence}
              {help && <HelpSteps help={help} />}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
