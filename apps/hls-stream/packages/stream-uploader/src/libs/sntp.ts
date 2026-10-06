import dgram from 'node:dgram';

/**
 * A minimal SNTP client (RFC 4330, the arithmetic of RFC 5905), on the standard library alone.
 *
 * One version 4 client request per server and the four timestamps of its answer: `t1` when the request
 * left this host, `t2` when the server received it, `t3` when the server answered, `t4` when the answer
 * arrived here. `t1` and `t4` are read from `Date.now`, because the clock in question is the one the
 * window writer dates windows by.
 */

/** The port a time server answers on. */
export const SNTP_PORT = 123;

/** Seconds from the NTP era's start, 1900-01-01, to the Unix epoch. */
const NTP_TO_UNIX_SECONDS = 2_208_988_800;
const MS_PER_SECOND = 1_000;
const FRACTION_PER_SECOND = 2 ** 32;

const PACKET_BYTES = 48;
const ORIGINATE_AT = 24;
const RECEIVE_AT = 32;
const TRANSMIT_AT = 40;
const TIMESTAMP_BYTES = 8;

const VERSION = 4;
const MODE_CLIENT = 3;
const MODE_SERVER = 4;
/** Leap indicator 3 is the server saying its own clock is not synchronised. */
const LEAP_ALARM = 3;
/** Stratum 0 is a kiss-o'-death, a server telling the client to go away, and 16 is unsynchronised. */
const STRATUM_KISS_OF_DEATH = 0;
const STRATUM_UNSYNCHRONISED = 16;

const MAX_PORT = 65_535;

/** One time server, as `CLOCK_CHECK_SERVERS` names it. */
export interface ClockServer {
  readonly host: string;
  readonly port: number;
}

/** One answer, as the clock check judges it. `offsetMs` is how far the server is ahead of this host. */
export interface ClockSample {
  /** The server as it was named, with its port only when it is not the standard one. */
  readonly server: string;
  readonly offsetMs: number;
  readonly delayMs: number;
}

/** The two server timestamps of an answer, in Unix milliseconds. */
interface SntpReply {
  readonly receiveMs: number;
  readonly transmitMs: number;
}

function writeTimestamp(packet: Buffer, at: number, unixMs: number): void {
  const seconds = Math.floor(unixMs / MS_PER_SECOND);
  const fraction = Math.round(((unixMs - seconds * MS_PER_SECOND) / MS_PER_SECOND) * FRACTION_PER_SECOND);
  packet.writeUInt32BE(seconds + NTP_TO_UNIX_SECONDS, at);
  packet.writeUInt32BE(Math.min(fraction, FRACTION_PER_SECOND - 1), at + 4);
}

function readTimestamp(packet: Buffer, at: number): number {
  const seconds = packet.readUInt32BE(at) - NTP_TO_UNIX_SECONDS;
  return seconds * MS_PER_SECOND + (packet.readUInt32BE(at + 4) / FRACTION_PER_SECOND) * MS_PER_SECOND;
}

/** A client request carrying its send time as the transmit timestamp, which the server echoes as the originate. */
export function encodeSntpRequest(sentAtMs: number): Buffer {
  const request = Buffer.alloc(PACKET_BYTES);
  request.writeUInt8((VERSION << 3) | MODE_CLIENT, 0);
  writeTimestamp(request, TRANSMIT_AT, sentAtMs);
  return request;
}

/**
 * The server's timestamps from an answer to `request`.
 *
 * Null for a packet that is not an answer to this request, too short or naming another request's
 * transmit time, which is a stray datagram to ignore while the real answer may still come. A throw for
 * an answer that refuses to tell the time: a kiss-o'-death, a server that says it is not synchronised,
 * or a packet that is not a server's.
 */
export function readSntpReply(reply: Buffer, request: Buffer): SntpReply | null {
  if (reply.length < PACKET_BYTES) {
    return null;
  }
  const echoed = reply.subarray(ORIGINATE_AT, ORIGINATE_AT + TIMESTAMP_BYTES);
  if (!echoed.equals(request.subarray(TRANSMIT_AT, TRANSMIT_AT + TIMESTAMP_BYTES))) {
    return null;
  }

  const first = reply.readUInt8(0);
  const mode = first & 0b111;
  if (mode !== MODE_SERVER) {
    throw new Error(`answered in mode ${mode}, where a server answers in mode ${MODE_SERVER}`);
  }
  if (first >> 6 === LEAP_ALARM) {
    throw new Error('says its own clock is not synchronised');
  }
  const stratum = reply.readUInt8(1);
  if (stratum === STRATUM_KISS_OF_DEATH || stratum >= STRATUM_UNSYNCHRONISED) {
    throw new Error(`answered at stratum ${stratum}, which carries no time`);
  }
  if (reply.readUInt32BE(TRANSMIT_AT) === 0 && reply.readUInt32BE(TRANSMIT_AT + 4) === 0) {
    throw new Error('answered with no transmit time');
  }

  return { receiveMs: readTimestamp(reply, RECEIVE_AT), transmitMs: readTimestamp(reply, TRANSMIT_AT) };
}

/** RFC 5905's offset and round-trip delay from the four timestamps, all in milliseconds. */
export function offsetAndDelay(t1: number, t2: number, t3: number, t4: number): { offsetMs: number; delayMs: number } {
  return { offsetMs: (t2 - t1 + (t3 - t4)) / 2, delayMs: t4 - t1 - (t3 - t2) };
}

function describeServer(server: ClockServer): string {
  return server.port === SNTP_PORT ? server.host : `${server.host}:${server.port}`;
}

/**
 * The servers `CLOCK_CHECK_SERVERS` names, a comma list of `host` or `host:port`.
 *
 * Refused at startup when it names nothing or a port that is not one, because a check with no server
 * reports unchecked for the life of the process and says nothing about why.
 */
export function parseClockServers(list: string): ClockServer[] {
  const entries = list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw new Error('CLOCK_CHECK_SERVERS names no time server');
  }

  return entries.map((entry) => {
    const colon = entry.lastIndexOf(':');
    // One colon is a port. None is a bare host, and more than one is an IPv6 literal with no port.
    if (colon === -1 || entry.indexOf(':') !== colon) {
      return { host: entry, port: SNTP_PORT };
    }
    const portText = entry.slice(colon + 1);
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > MAX_PORT) {
      throw new Error(`CLOCK_CHECK_SERVERS names ${entry}, whose port is not a port from 1 to ${MAX_PORT}`);
    }
    return { host: entry.slice(0, colon), port };
  });
}

/**
 * Asks one server once and measures this host against it.
 *
 * Rejects when nothing answers within `timeoutMs`, when the name does not resolve, or when the answer
 * refuses to tell the time. A packet that is not an answer to this request is ignored and the wait goes
 * on, since a stray datagram is no reason to give up on the answer behind it.
 */
export function querySntp(server: ClockServer, timeoutMs: number, now: () => number = Date.now): Promise<ClockSample> {
  const name = describeServer(server);

  return new Promise<ClockSample>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    let request: Buffer = Buffer.alloc(0);
    let sentAtMs = 0;

    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref();

    let isSettled = false;

    function finish(outcome: Error | ClockSample): void {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(timer);
      socket.removeAllListeners('message');
      socket.close();
      if (outcome instanceof Error) {
        reject(new Error(`${name}: ${outcome.message}`));
      } else {
        resolve(outcome);
      }
    }

    socket.on('error', (error) => finish(error));
    socket.on('message', (packet) => {
      const receivedAtMs = now();
      let reply: SntpReply | null;
      try {
        reply = readSntpReply(packet, request);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (reply === null) {
        return;
      }
      const { offsetMs, delayMs } = offsetAndDelay(sentAtMs, reply.receiveMs, reply.transmitMs, receivedAtMs);
      finish({ server: name, offsetMs, delayMs });
    });

    sentAtMs = now();
    request = encodeSntpRequest(sentAtMs);
    socket.send(request, server.port, server.host, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}
