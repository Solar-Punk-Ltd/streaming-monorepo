import type { Topic } from '@ethersphere/bee-js';

import { GatewayClock } from '@/utils/gatewayClock';

import { type AnswerKind, serverTimeOf, type SwarmAnswer } from './answers';
import { DEFAULT_READ_TIMEOUT_MS, type ReadOptions, type SwarmProvider, type UrlUse } from './provider';

/** The parts of the app that read Swarm, each of which the client may send to a provider of its own. */
export const SWARM_FEATURES = ['player', 'stream-list', 'previews'] as const;

export type SwarmFeature = (typeof SWARM_FEATURES)[number];

export type ReadKind = 'feed-head' | 'feed-entry' | 'soc' | 'chunk' | 'bytes';

/** A provider with the name the counts and the health report give it, such as a gateway's id in the settings. */
export interface NamedProvider {
  readonly id: string;
  readonly provider: SwarmProvider;
}

/** When a provider that keeps failing is left alone, and for how long. */
export interface PausePolicy {
  /** Faults in a row before the first pause. Once paused, one more fault pauses it again. */
  readonly faultsBeforePause: number;
  readonly firstPauseMs: number;
  /** Each pause in a row is twice the one before, up to this. */
  readonly longestPauseMs: number;
}

export const DEFAULT_PAUSE_POLICY: PausePolicy = {
  faultsBeforePause: 3,
  firstPauseMs: 15_000,
  longestPauseMs: 120_000,
};

export interface SwarmClientOptions {
  /** The provider every feature reads from unless {@link routes} names another. */
  readonly chosen: NamedProvider;
  /** Asked when a feature's own provider is paused, faults, is rate limited or cannot make a read. */
  readonly fallback?: NamedProvider | null;
  /** A provider of its own for a feature, with the same fallback. */
  readonly routes?: Partial<Record<SwarmFeature, NamedProvider>>;
  readonly pausePolicy?: Partial<PausePolicy>;
  /** Where the gateway's clock is kept. A fresh one when absent. */
  readonly clock?: GatewayClock;
  /** Injected by tests. The viewer's clock otherwise. */
  readonly now?: () => number;
}

/** What one feature reads Swarm through. */
export interface SwarmReader {
  readFeedHead(owner: string, topic: Topic, options?: ReadOptions): Promise<SwarmAnswer>;
  readFeedEntry(owner: string, topic: Topic, index: number, options?: ReadOptions): Promise<SwarmAnswer>;
  readSoc(owner: string, identifier: string, options?: ReadOptions): Promise<SwarmAnswer>;
  readChunk(address: string, options?: ReadOptions): Promise<SwarmAnswer>;
  readBytes(reference: string, options?: ReadOptions): Promise<SwarmAnswer>;
  /** A URL from the first provider that is not paused and gives URLs, or null when none does. */
  urlFor(reference: string, use: UrlUse): string | null;
}

export interface ReadCount {
  readonly feature: SwarmFeature;
  readonly read: ReadKind;
  readonly provider: string;
  readonly answer: AnswerKind;
  readonly count: number;
}

export interface ProviderHealth {
  readonly id: string;
  readonly faultsInARow: number;
  /** When the provider is asked again, on the client's clock, or null while it is not paused. */
  readonly pausedUntilMs: number | null;
}

interface HealthState {
  faultsInARow: number;
  pausedUntilMs: number | null;
  nextPauseMs: number;
}

type Ask = (provider: SwarmProvider, options: ReadOptions) => Promise<SwarmAnswer>;

/** Answers after which another provider may know better. Not found and aborted are final. */
const ASK_ANOTHER: ReadonlySet<AnswerKind> = new Set<AnswerKind>(['unavailable', 'rate-limited', 'unsupported']);

/**
 * The one way the app reads Swarm. It holds the chosen provider and a fallback, decides for each
 * feature which provider answers, leaves a provider that keeps failing alone for a while and then
 * tries it again, counts every read, and keeps the gateway's clock from every answer's server time.
 *
 * A paused provider is skipped only while another provider can be asked. When every provider for a
 * read is paused the feature's own provider is asked anyway, because a pause is a preference between
 * providers and a viewer with nothing else to read from should not wait it out.
 */
export class SwarmClient {
  private readonly chosen: NamedProvider;
  private readonly fallback: NamedProvider | null;
  private readonly routes: Partial<Record<SwarmFeature, NamedProvider>>;
  private readonly policy: PausePolicy;
  private readonly clock: GatewayClock;
  private readonly now: () => number;
  private readonly healthById = new Map<string, HealthState>();
  private readonly countByKey = new Map<string, ReadCount>();

  constructor(options: SwarmClientOptions) {
    this.chosen = options.chosen;
    this.fallback = options.fallback ?? null;
    this.routes = options.routes ?? {};
    this.policy = { ...DEFAULT_PAUSE_POLICY, ...options.pausePolicy };
    this.clock = options.clock ?? new GatewayClock();
    this.now = options.now ?? (() => Date.now());
  }

  reader(feature: SwarmFeature): SwarmReader {
    return {
      readFeedHead: (owner, topic, options) =>
        this.read(feature, 'feed-head', options, (provider, windowed) => provider.readFeedHead(owner, topic, windowed)),
      readFeedEntry: (owner, topic, index, options) =>
        this.read(feature, 'feed-entry', options, (provider, windowed) =>
          provider.readFeedEntry(owner, topic, index, windowed),
        ),
      readSoc: (owner, identifier, options) =>
        this.read(feature, 'soc', options, (provider, windowed) => provider.readSoc(owner, identifier, windowed)),
      readChunk: (address, options) =>
        this.read(feature, 'chunk', options, (provider, windowed) => provider.readChunk(address, windowed)),
      readBytes: (reference, options) =>
        this.read(feature, 'bytes', options, (provider, windowed) => provider.readBytes(reference, windowed)),
      urlFor: (reference, use) => this.urlFor(feature, reference, use),
    };
  }

  counts(): ReadCount[] {
    return [...this.countByKey.values()];
  }

  health(): ProviderHealth[] {
    return this.providers().map(({ id }) => {
      const state = this.healthOf(id);
      return { id, faultsInARow: state.faultsInARow, pausedUntilMs: this.isPaused(id) ? state.pausedUntilMs : null };
    });
  }

  /** What to add to the viewer's clock to read the gateway's. */
  clockOffsetMs(): number {
    return this.clock.offsetMs();
  }

  async start(): Promise<void> {
    await Promise.all(this.providers().map(({ provider }) => provider.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.providers().map(({ provider }) => provider.stop()));
  }

  /**
   * The caller's window covers the whole read, the fallback included, so a later provider is given
   * only what the earlier ones left and is not asked once nothing is left.
   */
  private async read(
    feature: SwarmFeature,
    read: ReadKind,
    options: ReadOptions | undefined,
    ask: Ask,
  ): Promise<SwarmAnswer> {
    const windowMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const startedAtMs = this.now();
    let answer: SwarmAnswer | null = null;
    for (const { id, provider } of this.candidatesFor(feature)) {
      const leftMs = windowMs - (this.now() - startedAtMs);
      if (answer !== null && leftMs <= 0) {
        return answer;
      }
      answer = await ask(provider, { ...options, timeoutMs: leftMs });
      this.count(feature, read, id, answer.kind);
      this.noteHealth(id, answer);
      const serverTimeMs = serverTimeOf(answer);
      if (serverTimeMs !== null) {
        this.clock.noteServerTime(serverTimeMs);
      }
      if (!ASK_ANOTHER.has(answer.kind)) {
        return answer;
      }
    }
    // Every candidate list holds at least the feature's own provider, so the loop ran.
    return answer as SwarmAnswer;
  }

  private urlFor(feature: SwarmFeature, reference: string, use: UrlUse): string | null {
    for (const { provider } of this.candidatesFor(feature)) {
      const url = provider.capabilities.urls ? provider.urlFor(reference, use) : null;
      if (url !== null) {
        return url;
      }
    }
    return null;
  }

  /** The feature's own provider then the fallback, the paused ones left out while another remains. */
  private candidatesFor(feature: SwarmFeature): NamedProvider[] {
    const primary = this.routes[feature] ?? this.chosen;
    const all = this.fallback && this.fallback.id !== primary.id ? [primary, this.fallback] : [primary];
    const awake = all.filter(({ id }) => !this.isPaused(id));
    return awake.length > 0 ? awake : [primary];
  }

  private providers(): NamedProvider[] {
    const byId = new Map<string, NamedProvider>();
    for (const named of [this.chosen, this.fallback, ...Object.values(this.routes)]) {
      if (named && !byId.has(named.id)) {
        byId.set(named.id, named);
      }
    }
    return [...byId.values()];
  }

  private noteHealth(id: string, answer: SwarmAnswer): void {
    const state = this.healthOf(id);
    switch (answer.kind) {
      case 'content':
      case 'not-found':
        state.faultsInARow = 0;
        state.pausedUntilMs = null;
        state.nextPauseMs = this.policy.firstPauseMs;
        return;
      case 'unavailable':
        state.faultsInARow += 1;
        if (state.faultsInARow >= this.policy.faultsBeforePause) {
          state.pausedUntilMs = this.now() + state.nextPauseMs;
          state.nextPauseMs = Math.min(state.nextPauseMs * 2, this.policy.longestPauseMs);
        }
        return;
      case 'rate-limited':
        state.pausedUntilMs = this.now() + (answer.retryAfterMs ?? this.policy.firstPauseMs);
        return;
      case 'unsupported':
      case 'aborted':
        return;
    }
  }

  private isPaused(id: string): boolean {
    const { pausedUntilMs } = this.healthOf(id);
    return pausedUntilMs !== null && this.now() < pausedUntilMs;
  }

  private healthOf(id: string): HealthState {
    let state = this.healthById.get(id);
    if (!state) {
      state = { faultsInARow: 0, pausedUntilMs: null, nextPauseMs: this.policy.firstPauseMs };
      this.healthById.set(id, state);
    }
    return state;
  }

  private count(feature: SwarmFeature, read: ReadKind, provider: string, answer: AnswerKind): void {
    const key = `${feature}|${read}|${provider}|${answer}`;
    const current = this.countByKey.get(key);
    this.countByKey.set(key, { feature, read, provider, answer, count: (current?.count ?? 0) + 1 });
  }
}
