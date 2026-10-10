import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppContext } from '@/providers/App';
import { createSwarmClient } from '@/swarm/createSwarmClient';
import { chooseSource } from '@/swarm/routing';
import { gatewaySettingOf, type Source, sourceName, type SourceType } from '@/swarm/sources';
import { BUILD_LABEL } from '@/utils/buildLabel';

import { type AddCheck, AddSource } from './AddSource';
import { FallbackOrder } from './FallbackOrder';
import { describeProbeFailure, onlyGateway, probeFailureHelp, probeGateway } from './gatewayProbe';
import { statusRows } from './providerStatus';
import { type CheckResult, testProvider } from './providerTest';
import { reportText, type TestedGateway } from './report';
import { type SourceTest, SourceRow } from './SourceRow';
import { useSourceStatuses } from './useSourceStatuses';

/** How often the status rows read the client's counts again while the picker is open. */
const STATUS_REFRESH_MS = 2_000;

/** The id a gateway being added is tested under, before it has one of its own. */
const ADDING_ID = 'adding';

type CopyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'copied' }
  | { readonly kind: 'failed'; readonly report: string };

const NOT_COPIED: CopyState = { kind: 'idle' };

/**
 * The node picker's sources and debug tools: every source with a status dot from a light check every
 * 10 s, a Test of each on this deployment's real content, adding, renaming and removing the viewer's
 * own, the fallback order, who answered each feature in the last minute, and a copyable report. They
 * live only while the picker is open, so the checks and tests they start stop when it closes.
 */
export function GatewayTools() {
  const app = useAppContext();
  const { swarmSettings: settings, sources, routing, parts, fallbackOrder, swarm, streamList, catalogFeed } = app;
  const [tests, setTests] = useState<Record<string, SourceTest>>({});
  const [lastTested, setLastTested] = useState<TestedGateway | null>(null);
  const [copy, setCopy] = useState<CopyState>(NOT_COPIED);
  const [, setRefreshes] = useState(0);
  const running = useRef(new Set<AbortController>());
  const { statuses, recheck } = useSourceStatuses(sources, true, catalogFeed);
  const nameOf = useCallback((id: string) => sourceName(sources, id), [sources]);

  useEffect(() => {
    const timer = setInterval(() => setRefreshes((count) => count + 1), STATUS_REFRESH_MS);
    const controllers = running.current;
    return () => {
      clearInterval(timer);
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const runTest = async (source: Source): Promise<readonly CheckResult[] | null> => {
    const controller = new AbortController();
    running.current.add(controller);
    setTests((current) => ({ ...current, [source.id]: { state: 'running' } }));
    const results = await testProvider({
      client: createSwarmClient(onlyGateway(gatewaySettingOf(source))),
      address: source.url,
      catalog: catalogFeed,
      knownStreams: streamList,
      isOwnNode: source.type === 'bee-node',
      clockOffsetMs: swarm.clockOffsetMs(),
      signal: controller.signal,
    });
    running.current.delete(controller);
    if (controller.signal.aborted) {
      return null;
    }
    setTests((current) => ({ ...current, [source.id]: { state: 'done', results } }));
    setLastTested({ name: source.name, address: source.url, results });
    setCopy(NOT_COPIED);
    return results;
  };

  const test = (source: Source) => {
    recheck(source.id);
    void runTest(source);
  };

  /** A Bee node is asked the picker's probe, a gateway the Test, whose connection must pass. */
  const checkNew = async (type: SourceType, url: string): Promise<AddCheck> => {
    if (type === 'bee-node') {
      const outcome = await probeGateway(url);
      return outcome.kind === 'ok'
        ? { ok: true }
        : { ok: false, text: describeProbeFailure(outcome), help: probeFailureHelp(outcome, window.location.origin) };
    }
    const results = await runTest({ id: ADDING_ID, type, name: 'New gateway', url, offered: false });
    setTests(({ [ADDING_ID]: _checked, ...current }) => current);
    const connection = results?.find(({ check }) => check === 'connection');
    if (connection === undefined) {
      return { ok: false, text: 'The check was stopped before it finished.', help: null };
    }
    return connection.outcome === 'passed'
      ? { ok: true, results: results ?? undefined }
      : { ok: false, text: connection.sentence, help: connection.help ?? null };
  };

  const add = (source: { type: SourceType; name: string; url: string }, results?: readonly CheckResult[]) => {
    const id = app.addSource(source);
    if (results) {
      setTests((current) => ({ ...current, [id]: { state: 'done', results } }));
    }
    if (routing.mode === 'one') {
      app.setRouting(chooseSource(routing, id));
    }
  };

  const status = statusRows(swarm.activity(), swarm.health(), Date.now(), nameOf);

  const copyReport = async () => {
    const text = reportText({
      tested: lastTested,
      status,
      build: BUILD_LABEL,
      browser: navigator.userAgent,
      atMs: Date.now(),
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopy({ kind: 'copied' });
    } catch {
      setCopy({ kind: 'failed', report: text });
    }
  };

  return (
    <div className="gateway-tools">
      <h4 className="gateway-tools-title">Sources</h4>
      <ul className="gateway-tools-list" aria-label="Sources">
        {sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            isInUse={routing.mode === 'one' && source.id === parts.player}
            isFallback={fallbackOrder.includes(source.id)}
            canUse={routing.mode === 'one'}
            status={statuses[source.id]}
            test={tests[source.id]}
            onUse={() => app.setRouting(chooseSource(routing, source.id))}
            onTest={() => test(source)}
            onRename={(name) => app.renameSource(source.id, name)}
            onRemove={() => app.removeSource(source.id)}
          />
        ))}
      </ul>

      <AddSource kinds={settings.kinds} check={checkNew} onAdd={add} />

      <FallbackOrder order={fallbackOrder} nameOf={nameOf} onChange={app.setFallbackOrder} />

      <section aria-label="Status">
        <h4 className="gateway-tools-title">Who answered in the last minute</h4>
        <dl className="gateway-tools-status">
          {status.map((row) => (
            <div key={row.feature}>
              <dt>{row.label}</dt>
              <dd>
                {row.route} {row.answered}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label="Report">
        <button className="gateway-tools-button" onClick={() => void copyReport()}>
          Copy report
        </button>
        <span className="gateway-tools-note" role="status">
          {copy.kind === 'copied' && ' Report copied.'}
          {copy.kind === 'failed' && ' This browser did not let the page copy. Select the report below and copy it.'}
        </span>
        {copy.kind === 'failed' && (
          <textarea className="gateway-tools-report" readOnly value={copy.report} aria-label="Report" rows={8} />
        )}
      </section>
    </div>
  );
}
