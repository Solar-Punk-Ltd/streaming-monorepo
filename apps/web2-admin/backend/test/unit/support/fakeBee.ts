/**
 * A Bee API of the tests' own, on a random port of 127.0.0.1: the few endpoints writing and moving the catalogue call,
 * answered the way a node answers them, with every upload recorded as the chunk address, the exact bytes and the batch
 * that stamped them. Nothing here reaches a network.
 *
 * - `POST /soc/{owner}/{id}?sig=`: a single-owner chunk, checked the way Bee checks one (the signature has to recover
 *   the owner whose address with the identifier is the chunk's address), stored as identifier, signature, span and
 *   payload.
 * - `POST /bytes`: content-addressed data, split into the standard chunk tree (4096-byte leaves, 128 references a
 *   node), every chunk recorded.
 * - `GET /chunks/{ref}`, `GET /bytes/{ref}`: what any upload stored, whatever batch stamped it: the network.
 * - `POST /bzz?name=`, `GET` and `HEAD /bzz/{ref}/`: a file, whose reference is a hash of its name, type and bytes,
 *   so the same file gives the same reference as Bee's manifest does.
 *
 * `beforeAnswer` runs before an upload is answered, so a test can write the catalogue while a move is on its way or
 * hold a call for ever, as a process that died would. `failNext` answers the next matching upload with an error.
 */
import http from 'node:http';

import { Bee, Bytes } from '@ethersphere/bee-js';

export interface FakeUpload {
  kind: 'soc' | 'chunk' | 'file';
  /** The chunk address, or the file's reference. */
  address: string;
  bytes: Uint8Array;
  batch: string | null;
}

/** A Bee client for its pure helpers alone (chunk hashing, SOC checks); it is never asked anything over HTTP. */
const helpers = new Bee('http://127.0.0.1:1633');

const CHUNK_SIZE = 4096;
const BRANCHES = 128;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function spanOf(bytes: Uint8Array): bigint {
  return Buffer.from(bytes.subarray(0, 8)).readBigUInt64LE();
}

async function body(req: http.IncomingMessage): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

export class FakeBee {
  url = '';
  readonly uploads: FakeUpload[] = [];
  /** Every chunk any upload stored, by address: what a read through any node finds. */
  readonly chunks = new Map<string, Uint8Array>();
  readonly files = new Map<string, { bytes: Uint8Array; name: string; contentType: string }>();
  beforeAnswer: ((upload: FakeUpload) => Promise<void> | void) | null = null;
  failNext: { kind: FakeUpload['kind']; status: number; batch?: string } | null = null;
  private server: http.Server | null = null;

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: String(error), code: 500 }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('the fake Bee did not report a port');
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** The uploads one batch stamped, in order. */
  under(batch: string, kind?: FakeUpload['kind']): FakeUpload[] {
    return this.uploads.filter((upload) => upload.batch === batch && (kind === undefined || upload.kind === kind));
  }

  /** The address and bytes of every upload one batch stamped, by address: what that batch holds. */
  heldBy(batch: string): Map<string, string> {
    return new Map(this.under(batch).map((upload) => [upload.address, hex(upload.bytes)]));
  }

  /** Forgets every chunk one batch stamped and no other did, as the network does once the batch lapses. */
  lapse(batch: string): void {
    const kept = new Set(this.uploads.filter((u) => u.batch !== batch).map((u) => u.address));
    for (const upload of this.under(batch)) {
      if (!kept.has(upload.address)) {
        this.chunks.delete(upload.address);
        this.files.delete(upload.address);
      }
    }
  }

  /** The standard chunk tree of `data`, its chunks stored and recorded, and its root's address. */
  split(data: Uint8Array, batch: string | null): string {
    let level: { address: string; span: bigint }[] = [];
    for (let at = 0; at < Math.max(data.length, 1); at += CHUNK_SIZE) {
      const payload = data.subarray(at, at + CHUNK_SIZE);
      level.push({
        address: this.store('chunk', payload, BigInt(payload.length), batch),
        span: BigInt(payload.length),
      });
    }
    while (level.length > 1) {
      const next: typeof level = [];
      for (let at = 0; at < level.length; at += BRANCHES) {
        const group = level.slice(at, at + BRANCHES);
        const payload = Buffer.concat(group.map((child) => Buffer.from(child.address, 'hex')));
        const span = group.reduce((sum, child) => sum + child.span, 0n);
        next.push({ address: this.store('chunk', new Uint8Array(payload), span, batch), span });
      }
      level = next;
    }
    return level[0]!.address;
  }

  /** The data under a root, joined back from the chunks the network holds, or null when one is missing. */
  join(address: string): Uint8Array | null {
    const chunk = this.chunks.get(address);
    if (!chunk) return null;
    const span = spanOf(chunk);
    const payload = chunk.subarray(8);
    if (span <= BigInt(CHUNK_SIZE)) return payload.subarray(0, Number(span));
    const parts: Uint8Array[] = [];
    for (let at = 0; at < payload.length; at += 32) {
      const part = this.join(hex(payload.subarray(at, at + 32)));
      if (!part) return null;
      parts.push(part);
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  private store(kind: 'chunk', payload: Uint8Array, span: bigint, batch: string | null): string {
    const chunk = helpers.makeContentAddressedChunk(payload, span);
    const address = chunk.address.toHex();
    const bytes = new Uint8Array(chunk.data);
    this.uploads.push({ kind, address, bytes, batch });
    this.chunks.set(address, bytes);
    return address;
  }

  private failing(kind: FakeUpload['kind'], batch: string | null): number | null {
    const fail = this.failNext;
    if (!fail || fail.kind !== kind || (fail.batch !== undefined && fail.batch !== batch)) return null;
    this.failNext = null;
    return fail.status;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake-bee.invalid');
    const batch = (req.headers['swarm-postage-batch-id'] as string | undefined)?.toLowerCase() ?? null;
    const json = (status: number, answer: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    };
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'soc' && parts.length === 3) {
      const data = await body(req);
      const owner = parts[1]!.toLowerCase();
      const identifier = parts[2]!.toLowerCase();
      const signature = url.searchParams.get('sig') ?? '';
      const bytes = new Uint8Array(
        Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(signature, 'hex'), Buffer.from(data)]),
      );
      const address = Bytes.keccak256(
        Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(owner, 'hex')]),
      ).toHex();
      try {
        helpers.unmarshalSingleOwnerChunk(bytes, address);
      } catch (error) {
        return json(400, { message: `invalid chunk: ${String(error)}`, code: 400 });
      }
      const upload: FakeUpload = { kind: 'soc', address, bytes, batch };
      await this.beforeAnswer?.(upload);
      const failed = this.failing('soc', batch);
      if (failed) return json(failed, { message: 'refused', code: failed });
      this.uploads.push(upload);
      this.chunks.set(address, bytes);
      return json(201, { reference: address });
    }

    if (req.method === 'POST' && url.pathname === '/bytes') {
      const data = await body(req);
      const failed = this.failing('chunk', batch);
      if (failed) return json(failed, { message: 'refused', code: failed });
      return json(201, { reference: this.split(data, batch) });
    }

    if (req.method === 'GET' && parts[0] === 'chunks' && parts.length === 2) {
      const chunk = this.chunks.get(parts[1]!.toLowerCase());
      if (!chunk) return json(404, { message: 'Not Found', code: 404 });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(chunk));
      return;
    }

    if (req.method === 'GET' && parts[0] === 'bytes' && parts.length === 2) {
      const data = this.join(parts[1]!.toLowerCase());
      if (!data) return json(404, { message: 'Not Found', code: 404 });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(data));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/bzz') {
      const bytes = await body(req);
      const name = url.searchParams.get('name') ?? '';
      const contentType = (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
      const address = Bytes.keccak256(
        Buffer.concat([Buffer.from(`${name}\n${contentType}\n`), Buffer.from(bytes)]),
      ).toHex();
      const upload: FakeUpload = { kind: 'file', address, bytes, batch };
      await this.beforeAnswer?.(upload);
      const failed = this.failing('file', batch);
      if (failed) return json(failed, { message: 'refused', code: failed });
      this.uploads.push(upload);
      this.files.set(address, { bytes, name, contentType });
      return json(201, { reference: address });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && parts[0] === 'bzz' && parts.length >= 2) {
      const file = this.files.get(parts[1]!.toLowerCase());
      if (!file) return json(404, { message: 'Not Found', code: 404 });
      res.writeHead(200, {
        'content-type': file.contentType,
        'content-disposition': `inline; filename="${file.name}"`,
      });
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(file.bytes));
      return;
    }

    json(404, { message: `the fake Bee has no ${req.method} ${url.pathname}`, code: 404 });
  }
}
