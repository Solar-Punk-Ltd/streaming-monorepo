import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  encodeSntpRequest,
  offsetAndDelay,
  parseClockServers,
  querySntp,
  readSntpReply,
  SNTP_PORT,
} from '../src/libs/sntp.js';

import { readNtpTimestamp, startFakeSntpServer, writeNtpTimestamp } from './helpers/fakeSntpServer.js';

const servers: { close(): Promise<void> }[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function fakeServer(options: Parameters<typeof startFakeSntpServer>[0] = {}) {
  const server = await startFakeSntpServer(options);
  servers.push(server);
  return server;
}

/** A reply to `request` as a server would write it, with the given receive and transmit times. */
function replyTo(request: Buffer, receiveMs: number, transmitMs: number, first = 0x24, stratum = 2): Buffer {
  const reply = Buffer.alloc(48);
  reply.writeUInt8(first, 0);
  reply.writeUInt8(stratum, 1);
  request.copy(reply, 24, 40, 48);
  writeNtpTimestamp(reply, 32, receiveMs);
  writeNtpTimestamp(reply, 40, transmitMs);
  return reply;
}

const SOME_MOMENT_MS = Date.UTC(2026, 9, 6, 12, 0, 0, 125);

describe('the SNTP request', () => {
  it('is 48 bytes, version 4, client mode, with no leap warning', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    assert.equal(request.length, 48);
    assert.equal(request.readUInt8(0) >> 6, 0, 'leap indicator');
    assert.equal((request.readUInt8(0) >> 3) & 0b111, 4, 'version');
    assert.equal(request.readUInt8(0) & 0b111, 3, 'mode 3 is a client');
  });

  it('carries its send time as the transmit timestamp, which the server echoes back as the originate', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    assert.ok(Math.abs(readNtpTimestamp(request, 40) - SOME_MOMENT_MS) < 0.001);
    assert.ok(
      request.subarray(0, 40).every((byte, index) => index === 0 || byte === 0),
      'nothing else is set',
    );
  });
});

describe('reading an SNTP reply', () => {
  it('reads the receive and transmit times of an answer to this request', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    const reply = readSntpReply(replyTo(request, SOME_MOMENT_MS + 40.5, SOME_MOMENT_MS + 41.25), request);
    assert.ok(reply);
    assert.ok(Math.abs(reply.receiveMs - (SOME_MOMENT_MS + 40.5)) < 0.001);
    assert.ok(Math.abs(reply.transmitMs - (SOME_MOMENT_MS + 41.25)) < 0.001);
  });

  it('answers null for a packet that names another request, so a stray answer is not read as ours', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    const other = encodeSntpRequest(SOME_MOMENT_MS + 1);
    assert.equal(readSntpReply(replyTo(other, SOME_MOMENT_MS, SOME_MOMENT_MS), request), null);
  });

  it('answers null for a packet too short to be an answer', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    assert.equal(readSntpReply(Buffer.alloc(47), request), null);
  });

  it('refuses a kiss-o-death, a server that is not synchronised, and a packet that is not a server answer', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    assert.throws(() => readSntpReply(replyTo(request, SOME_MOMENT_MS, SOME_MOMENT_MS, 0x24, 0), request), /stratum 0/);
    assert.throws(
      () => readSntpReply(replyTo(request, SOME_MOMENT_MS, SOME_MOMENT_MS, 0xe4), request),
      /not synchronised/,
    );
    assert.throws(() => readSntpReply(replyTo(request, SOME_MOMENT_MS, SOME_MOMENT_MS, 0x23), request), /mode 3/);
  });

  it('refuses an answer with no transmit time', () => {
    const request = encodeSntpRequest(SOME_MOMENT_MS);
    const reply = replyTo(request, SOME_MOMENT_MS, SOME_MOMENT_MS);
    reply.fill(0, 40, 48);
    assert.throws(() => readSntpReply(reply, request), /transmit/);
  });
});

describe('the offset and the round trip', () => {
  it('are RFC 5905 arithmetic on the four timestamps', () => {
    // Sent at 1000 by the host, received at 1110 and answered at 1112 by the server, back at 1022.
    // The server is 100 ahead and each leg took 10.
    assert.deepEqual(offsetAndDelay(1000, 1110, 1112, 1022), { offsetMs: 100, delayMs: 20 });
  });

  it('reads a host that is ahead as a negative offset', () => {
    assert.deepEqual(offsetAndDelay(1000, 760, 760, 1020), { offsetMs: -250, delayMs: 20 });
  });
});

describe('the server list', () => {
  it('takes host names, with the NTP port unless one is given', () => {
    assert.deepEqual(parseClockServers('time.example.com, 192.0.2.10:1123'), [
      { host: 'time.example.com', port: SNTP_PORT },
      { host: '192.0.2.10', port: 1123 },
    ]);
  });

  it('refuses an empty list and a port that is not one', () => {
    assert.throws(() => parseClockServers(' , '), /CLOCK_CHECK_SERVERS/);
    assert.throws(() => parseClockServers('time.example.com:0'), /port/);
    assert.throws(() => parseClockServers('time.example.com:123x'), /port/);
    assert.throws(() => parseClockServers('time.example.com:65536'), /port/);
  });

  it('refuses an IPv6 address, which the IPv4 socket the check asks through can never reach', () => {
    assert.throws(
      () => parseClockServers('time.example.com,2001:db8::1'),
      /CLOCK_CHECK_SERVERS names 2001:db8::1, an IPv6/,
    );
    assert.throws(
      () => parseClockServers('[2001:db8::1]:123'),
      /CLOCK_CHECK_SERVERS names \[2001:db8::1\]:123, an IPv6/,
    );
  });
});

describe('one SNTP query on the loopback', () => {
  it('measures a server 300 ms ahead as an offset of about 300 ms', async () => {
    const server = await fakeServer({ offsetMs: 300 });
    const sample = await querySntp({ host: '127.0.0.1', port: server.port }, 1_000);
    assert.equal(server.requests.length, 1);
    assert.ok(Math.abs(sample.offsetMs - 300) < 20, `offset ${sample.offsetMs}`);
    assert.ok(sample.delayMs >= 0 && sample.delayMs < 50, `delay ${sample.delayMs}`);
    assert.equal(sample.server, server.address);
  });

  it('measures the round trip a slow server adds', async () => {
    const server = await fakeServer({ offsetMs: 0, delayMs: 120 });
    const sample = await querySntp({ host: '127.0.0.1', port: server.port }, 1_000);
    assert.ok(sample.delayMs >= 110 && sample.delayMs < 250, `delay ${sample.delayMs}`);
    assert.ok(Math.abs(sample.offsetMs) < 30, `offset ${sample.offsetMs}`);
  });

  it('ignores a stray packet and reads the answer to its own request', async () => {
    const server = await fakeServer({ offsetMs: 10, sendStrayFirst: true });
    const sample = await querySntp({ host: '127.0.0.1', port: server.port }, 1_000);
    assert.ok(Math.abs(sample.offsetMs - 10) < 20, `offset ${sample.offsetMs}`);
  });

  it('gives up after its timeout when nothing answers', async () => {
    const server = await fakeServer({ silent: true });
    const startedAt = Date.now();
    await assert.rejects(querySntp({ host: '127.0.0.1', port: server.port }, 150), /no answer within 150 ms/);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(server.requests.length, 1);
  });

  it('rejects a kiss-o-death rather than reading a time from it', async () => {
    const server = await fakeServer({ stratum: 0 });
    await assert.rejects(querySntp({ host: '127.0.0.1', port: server.port }, 1_000), /stratum 0/);
  });
});
