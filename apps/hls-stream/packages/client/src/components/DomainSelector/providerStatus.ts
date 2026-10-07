/**
 * The node picker's status rows: who answered each feature in the last minute, in words, from the
 * Swarm client's own counts. Pure, so the picker only refreshes them.
 */
import type { AnswerKind } from '@/swarm/answers';
import type { FeatureActivity, ProviderHealth, SwarmFeature } from '@/swarm/client';

const FEATURE_LABELS: Readonly<Record<SwarmFeature, string>> = {
  'stream-list': 'Stream list',
  player: 'Video',
  previews: 'Previews and pictures',
};

const ANSWER_WORDS: Readonly<Record<AnswerKind, string>> = {
  content: 'served',
  'not-found': 'not there yet',
  'rate-limited': 'asked to slow down',
  unsupported: 'could not read',
  unavailable: 'failed',
  aborted: 'stopped',
};

export interface StatusRow {
  readonly feature: SwarmFeature;
  readonly label: string;
  /** Which provider the feature reads from and which stands behind it. */
  readonly route: string;
  /** What answered in the last minute, or that nothing did. */
  readonly answered: string;
}

/** A provider's name as a viewer knows it, never its address. */
type NameOf = (providerId: string) => string;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The status rows, one per feature, in the order the client lists them. */
export function statusRows(
  activity: readonly FeatureActivity[],
  health: readonly ProviderHealth[],
  nowMs: number,
  nameOf: NameOf,
): StatusRow[] {
  return activity.map(({ feature, primary, fallback, answers, fallbacks }) => {
    const pause = (id: string) => {
      const until = health.find((provider) => provider.id === id)?.pausedUntilMs ?? null;
      return until === null ? '' : `, paused for ${Math.max(1, Math.ceil((until - nowMs) / 1000))} s after failing`;
    };
    const route =
      `Reads from ${nameOf(primary)}${pause(primary)}.` +
      (fallback === null ? ' No fallback.' : ` Falls back to ${nameOf(fallback)}${pause(fallback)}.`);

    if (answers.length === 0) {
      return { feature, label: FEATURE_LABELS[feature], route, answered: 'Nothing read in the last minute.' };
    }
    const byProvider = new Map<string, string[]>();
    for (const { provider, answer, count } of answers) {
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), `${count} ${ANSWER_WORDS[answer]}`]);
    }
    const parts = [...byProvider].map(([provider, counts]) => `${nameOf(provider)}: ${counts.join(', ')}`);
    const fellBack = fallbacks === 0 ? '' : ` ${plural(fallbacks, 'answer', 'answers')} came from the fallback.`;
    return {
      feature,
      label: FEATURE_LABELS[feature],
      route,
      answered: `In the last minute, ${parts.join('. ')}.${fellBack}`,
    };
  });
}
