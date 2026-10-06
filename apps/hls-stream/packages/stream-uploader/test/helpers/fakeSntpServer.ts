import dgram from 'node:dgram';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { LOOPBACK_HOST } from './loopbackServer.js';

/** Seconds from the NTP era's start, 1900-01-01, to the Unix epoch. Written out again here on purpose. */
const NTP_TO_UNIX_SECONDS = 2_208_988_800;
const FRACTION_PER_SECOND = 2 ** 32;
const PACKET_BYTES = 48;
const MODE_SERVER = 4;
const VERSION = 4;
const ORIGINATE_AT = 24;
const RECEIVE_AT = 32;
const TRANSMIT_AT = 40;

/**
 * Writes an NTP timestamp, kept apart from the client's own encoder so a test of that encoder is checked
 * against a second, independent reading of RFC 5905 rather than against itself.
 */
export function writeNtpTimestamp(packet: Buffer, at: number, unixMs: number): void {
  const seconds = Math.floor(unixMs / 1000);
  const fraction = Math.min(
    FRACTION_PER_SECOND - 1,
    Math.round(((unixMs - seconds * 1000) / 1000) * FRACTION_PER_SECOND),
  );
  packet.writeUInt32BE(seconds + NTP_TO_UNIX_SECONDS, at);
  packet.writeUInt32BE(fraction, at + 4);
}

export function readNtpTimestamp(packet: Buffer, at: number): number {
  const seconds = packet.readUInt32BE(at) - NTP_TO_UNIX_SECONDS;
  return seconds * 1000 + (packet.readUInt32BE(at + 4) / FRACTION_PER_SECOND) * 1000;
}

interface FakeSntpOptions {
  /** How far this server's clock is ahead of the host's, so the client should measure the host this far behind. */
  offsetMs?: number;
  /** A round trip the server adds, half on the way in and half on the way out, so the path stays symmetric. */
  delayMs?: number;
  /** Never answers, which is a time server behind a firewall that drops UDP 123. */
  silent?: boolean;
  /** The stratum it reports. 0 is a kiss-o'-death, which a client must not read as a time. */
  stratum?: number;
  /** Answers with a packet that names a different request first, which a client must ignore. */
  sendStrayFirst?: boolean;
}

interface FakeSntpServer {
  /** `127.0.0.1:<port>`, the shape `CLOCK_CHECK_SERVERS` takes. */
  readonly address: string;
  readonly port: number;
  /** Requests received, every one of them, answered or not. */
  readonly requests: Buffer[];
  close(): Promise<void>;
}

/**
 * An SNTP server on the IPv4 loopback that answers with a chosen offset and a chosen delay.
 *
 * Every test of the clock check talks to one of these and never to a real time server, because a
 * CI container may have no outbound UDP and a test that needs the internet is
 * flaky by design.
 */
export async function startFakeSntpServer(options: FakeSntpOptions = {}): Promise<FakeSntpServer> {
  const { offsetMs = 0, delayMs = 0, silent = false, stratum = 2, sendStrayFirst = false } = options;
  const socket = dgram.createSocket('udp4');
  const requests: Buffer[] = [];

  socket.on('message', (request, from) => {
    requests.push(Buffer.from(request));
    if (silent) {
      return;
    }
    void answer(request, from);
  });

  async function answer(request: Buffer, from: dgram.RemoteInfo): Promise<void> {
    await sleep(delayMs / 2);
    const reply = Buffer.alloc(PACKET_BYTES);
    reply.writeUInt8((VERSION << 3) | MODE_SERVER, 0);
    reply.writeUInt8(stratum, 1);
    writeNtpTimestamp(reply, RECEIVE_AT, Date.now() + offsetMs);
    writeNtpTimestamp(reply, TRANSMIT_AT, Date.now() + offsetMs);
    await sleep(delayMs / 2);

    if (sendStrayFirst) {
      const stray = Buffer.from(reply);
      writeNtpTimestamp(stray, ORIGINATE_AT, 0);
      writeNtpTimestamp(stray, RECEIVE_AT, Date.now() + 3_600_000);
      writeNtpTimestamp(stray, TRANSMIT_AT, Date.now() + 3_600_000);
      socket.send(stray, from.port, from.address);
    }

    request.copy(reply, ORIGINATE_AT, TRANSMIT_AT, TRANSMIT_AT + 8);
    socket.send(reply, from.port, from.address);
  }

  socket.bind(0, LOOPBACK_HOST);
  await once(socket, 'listening');
  const { port } = socket.address() as AddressInfo;

  return {
    address: `${LOOPBACK_HOST}:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
