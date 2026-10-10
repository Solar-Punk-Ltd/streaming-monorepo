import type { SwarmAnswer } from '../../src/swarm/answers';
import type { ProviderCapabilities, ReadOptions, SwarmProvider, UrlUse } from '../../src/swarm/provider';

type ScriptedRead = 'feed-head' | 'feed-entry' | 'soc' | 'chunk' | 'bytes';

/** A provider whose every read answers what the test says it does now, and which logs what it was asked. */
export class ScriptedProvider implements SwarmProvider {
  capabilities: ProviderCapabilities = {
    feedHead: true,
    feedEntry: true,
    soc: true,
    chunk: true,
    bytes: true,
    urls: true,
    inTab: false,
  };

  /** What every read answers until the test changes it. */
  answer: SwarmAnswer = { kind: 'content', bytes: new Uint8Array([1]), feedIndex: null, serverTimeMs: null };

  readonly asked: ScriptedRead[] = [];
  /** The window each read was given, in the order asked, undefined where the caller named none. */
  readonly windows: (number | undefined)[] = [];
  /** Run as each read is asked, which is how a test makes a read take time on the client's clock. */
  onAsk: () => void = () => {};
  started = 0;
  stopped = 0;

  constructor(readonly name: string) {}

  async readFeedHead(_owner: string, _topic: unknown, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.ask('feed-head', options);
  }

  async readFeedEntry(_owner: string, _topic: unknown, _index: number, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.ask('feed-entry', options);
  }

  async readSoc(_owner: string, _identifier: string, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.ask('soc', options);
  }

  async readChunk(_address: string, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.ask('chunk', options);
  }

  async readBytes(_reference: string, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.ask('bytes', options);
  }

  urlFor(reference: string, use: UrlUse): string | null {
    return this.capabilities.urls ? `${this.name}:${use}:${reference}` : null;
  }

  status() {
    return { state: 'ready' as const };
  }

  async probe() {
    return { kind: 'ok' as const, elapsedMs: 0 };
  }

  async start(): Promise<void> {
    this.started += 1;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  private ask(read: ScriptedRead, options?: ReadOptions): SwarmAnswer {
    this.asked.push(read);
    this.windows.push(options?.timeoutMs);
    this.onAsk();
    return this.answer;
  }
}

export const content = (serverTimeMs: number | null = null): SwarmAnswer => ({
  kind: 'content',
  bytes: new Uint8Array([7]),
  feedIndex: null,
  serverTimeMs,
});

export const fault: SwarmAnswer = { kind: 'unavailable', cause: { kind: 'network', error: new TypeError('Failed') } };

export const notFound: SwarmAnswer = { kind: 'not-found', serverTimeMs: null };
