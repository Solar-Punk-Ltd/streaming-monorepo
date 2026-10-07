import type { Topic } from '@ethersphere/bee-js';

import { GatewayClock } from '@/utils/gatewayClock';

import { type AnswerKind, serverTimeOf, type SwarmAnswer } from './answers';
import {
  DEFAULT_READ_TIMEOUT_MS,
  type ProbeResult,
  type ReadOptions,
  type SwarmProvider,
  type UrlUse,
} from './provider';

export { loadUrl, type UrlLoadOptions } from './urlLoad';

/** The parts of the app that read Swarm, each of which the client may send to a provider of its own. */
const SWARM_FEATURES = ['player', 'stream-list', 'previews'] as const;

export type SwarmFeature = (typeof SWARM_FEATURES)[number];

/**
 * The features whose answers keep the gateway clock. The player's time markers sit at addresses
 * computed from that clock, so it is taken from the hosts the player and the stream list read, and a
 * feature routed to a host of its own cannot move it.
 */
const CLOCK_FEATURES: ReadonlySet<SwarmFeature> = new Set<SwarmFeature>(['player', 'stream-list']);

type ReadKind = 'feed-head' | 'feed-entry' | 'soc' | 'chunk' | 'bytes';

/** A provider with the name the counts and the health report give it, such as a gateway's id in the settings. */
export interface NamedProvider {
  readonly id: string;
  readonly provider: SwarmProvider;
}

/** When a provider that keeps failing is left alone, and for how long. */
interface PausePolicy {
  /** Faults in a row before the first pause. Once paused, one more fault pauses it again. */
  readonly faultsBeforePause: number;
  readonly firstPauseMs: number;
  /** Each pause in a row is twice the one before, up to this. */
  readonly longestPauseMs: number;
}

const DEFAULT_PAUSE_POLICY: PausePolicy = {
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
  /**
   * The id of the provider {@link urlFor} takes URLs from now, or null when none gives any. It changes
   * when that provider is paused or its pause ends, which is when URLs handed out before go stale.
   */
  urlSource(use: UrlUse): string | null;
}

interface ReadCount {
  readonly feature: SwarmFeature;
  readonly read: ReadKind;
  readonly provider: string;
  readonly answer: AnswerKind;
  readonly count: number;
}

/** How long the client remembers each read for {@link SwarmClient.activity}. */
const ACTIVITY_WINDOW_MS = 60_000;

interface ProviderAnswerCount {
  readonly provider: string;
  readonly answer: AnswerKind;
  readonly count: number;
}

/** What one feature read in the last {@link ACTIVITY_WINDOW_MS}, and from whom. */
interface FeatureActivity {
  readonly feature: SwarmFeature;
  /** The provider the feature reads from first. */
  readonly primary: string;
  /** The provider asked when that one fails, or null when there is none. */
  readonly fallback: string | null;
  /** Every answer in the window, by the provider that gave it and its kind, in the order first seen. */
  readonly answers: readonly ProviderAnswerCount[];
  /** Answers in the window that came from a provider other than {@link primary}. */
  readonly fallbacks: number;
}

interface RecentAnswer {
  readonly atMs: number;
  readonly feature: SwarmFeature;
  readonly provider: string;
  readonly answer: AnswerKind;
}

interface ProviderHealth {
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
 * tries it again, counts every read, and keeps the gateway's clock from the server time of the
 * player's and the stream list's answers.
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
  /** Oldest first, never older than {@link ACTIVITY_WINDOW_MS}. */
  private readonly recent: RecentAnswer[] = [];

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
      urlSource: () => this.urlProviderFor(feature)?.id ?? null,
    };
  }

  counts(): ReadCount[] {
    return [...this.countByKey.values()];
  }

  /** What each feature read in the last minute, for the node picker's status rows. */
  activity(): FeatureActivity[] {
    this.forgetOldAnswers();
    return SWARM_FEATURES.map((feature) => {
      const primary = this.primaryFor(feature);
      const byKey = new Map<string, ProviderAnswerCount>();
      let fallbacks = 0;
      for (const recent of this.recent) {
        if (recent.feature !== feature) {
          continue;
        }
        const key = `${recent.provider}|${recent.answer}`;
        const counted = byKey.get(key);
        byKey.set(key, { provider: recent.provider, answer: recent.answer, count: (counted?.count ?? 0) + 1 });
        if (recent.provider !== primary.id) {
          fallbacks += 1;
        }
      }
      return {
        feature,
        primary: primary.id,
        fallback: this.fallbackFor(primary)?.id ?? null,
        answers: [...byKey.values()],
        fallbacks,
      };
    });
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

  /** Asks the provider every feature reads from first whether it is there at all. Never rejects. */
  probe(options?: ReadOptions): Promise<ProbeResult> {
    return this.chosen.provider.probe(options);
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
      if (serverTimeMs !== null && CLOCK_FEATURES.has(feature)) {
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
    return this.urlProviderFor(feature)?.provider.urlFor(reference, use) ?? null;
  }

  private urlProviderFor(feature: SwarmFeature): NamedProvider | null {
    return this.candidatesFor(feature).find(({ provider }) => provider.capabilities.urls) ?? null;
  }

  private primaryFor(feature: SwarmFeature): NamedProvider {
    return this.routes[feature] ?? this.chosen;
  }

  private fallbackFor(primary: NamedProvider): NamedProvider | null {
    return this.fallback && this.fallback.id !== primary.id ? this.fallback : null;
  }

  /** The feature's own provider then the fallback, the paused ones left out while another remains. */
  private candidatesFor(feature: SwarmFeature): NamedProvider[] {
    const primary = this.primaryFor(feature);
    const fallback = this.fallbackFor(primary);
    const all = fallback ? [primary, fallback] : [primary];
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
    this.recent.push({ atMs: this.now(), feature, provider, answer });
    this.forgetOldAnswers();
  }

  private forgetOldAnswers(): void {
    const oldestKeptMs = this.now() - ACTIVITY_WINDOW_MS;
    let old = 0;
    while (old < this.recent.length && this.recent[old].atMs < oldestKeptMs) {
      old += 1;
    }
    this.recent.splice(0, old);
  }
}
