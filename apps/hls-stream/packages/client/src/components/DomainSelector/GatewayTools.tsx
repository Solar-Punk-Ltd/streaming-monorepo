import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppContext } from '@/providers/App';
import { createSwarmClient } from '@/swarm/createSwarmClient';
import { choiceForAddress, gatewayName, type GatewaySetting, OWN_GATEWAY_ID } from '@/swarm/settings';
import { BUILD_LABEL } from '@/utils/buildLabel';

import { onlyGateway } from './gatewayProbe';
import { statusRows } from './providerStatus';
import { CHECK_LABELS, testProvider } from './providerTest';
import { reportText, type TestedGateway } from './report';

/** How often the status rows read the client's counts again while the picker is open. */
const STATUS_REFRESH_MS = 2_000;

type GatewayTest = { readonly state: 'running' } | ({ readonly state: 'done' } & TestedGateway);

type CopyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'copied' }
  | { readonly kind: 'failed'; readonly report: string };

const NOT_COPIED: CopyState = { kind: 'idle' };

/** Where a gateway is, as a viewer can recognise it: its host, or this site for a path such as `/bee`. */
function whereIs(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'this site';
  }
}

/**
 * The node picker's debug tools: test any gateway the build offers on this deployment's real content,
 * see who answered each feature in the last minute, and copy a report for whoever runs the site. They
 * live only while the picker is open, so the tests they start stop when it closes.
 */
export function GatewayTools() {
  const { swarmSettings: settings, gatewayUrl, swarm, streamList, catalogFeed } = useAppContext();
  const [tests, setTests] = useState<Record<string, GatewayTest>>({});
  const [lastTested, setLastTested] = useState<TestedGateway | null>(null);
  const [copy, setCopy] = useState<CopyState>(NOT_COPIED);
  const [, setRefreshes] = useState(0);
  const running = useRef(new Set<AbortController>());

  const choice = useMemo(() => choiceForAddress(settings, gatewayUrl), [settings, gatewayUrl]);
  const nameOf = useCallback((id: string) => gatewayName(settings, id), [settings]);
  const fallbackId = swarm.activity().find(({ feature }) => feature === 'player')?.fallback ?? null;
  const testable: readonly GatewaySetting[] =
    choice.id === OWN_GATEWAY_ID ? [...settings.gateways, choice] : settings.gateways;

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

  const runTest = async (gateway: GatewaySetting) => {
    const controller = new AbortController();
    running.current.add(controller);
    setTests((current) => ({ ...current, [gateway.id]: { state: 'running' } }));
    const results = await testProvider({
      client: createSwarmClient(onlyGateway(gateway)),
      address: gateway.url,
      catalog: catalogFeed,
      knownStreams: streamList,
      clockOffsetMs: swarm.clockOffsetMs(),
      signal: controller.signal,
    });
    running.current.delete(controller);
    if (controller.signal.aborted) {
      return;
    }
    const tested: TestedGateway = { name: nameOf(gateway.id), address: gateway.url, results };
    setTests((current) => ({ ...current, [gateway.id]: { state: 'done', ...tested } }));
    setLastTested(tested);
    setCopy(NOT_COPIED);
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
      <h4 className="gateway-tools-title">Test a gateway</h4>
      <ul className="gateway-tools-list" aria-label="Gateways">
        {testable.map((gateway) => {
          const test = tests[gateway.id];
          const isInUse = gateway.id === choice.id;
          return (
            <li key={gateway.id} className="gateway-tools-row" data-gateway-row>
              <div className="gateway-tools-row-heading">
                <span className="gateway-tools-name">{nameOf(gateway.id)}</span>
                <span className="gateway-tools-where">
                  {whereIs(gateway.url)}
                  {isInUse && ', in use'}
                  {!isInUse && gateway.id === fallbackId && ', fallback'}
                </span>
                <button
                  className="gateway-tools-button"
                  onClick={() => void runTest(gateway)}
                  disabled={test?.state === 'running'}
                  aria-label={`${test?.state === 'running' ? 'Testing' : 'Test'} ${nameOf(gateway.id)}`}
                >
                  {test?.state === 'running' ? 'Testing...' : 'Test'}
                </button>
              </div>
              {test?.state === 'running' && <p className="gateway-tools-note">Testing every feature...</p>}
              {test?.state === 'done' && (
                <ul className="gateway-tools-results" aria-label={`Test of ${test.name}`}>
                  {test.results.map(({ check, outcome, sentence }) => (
                    <li key={check} className={`gateway-tools-result ${outcome}`}>
                      {CHECK_LABELS[check]}: {outcome === 'skipped' ? 'not tested' : outcome}. {sentence}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

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
