import type { Request } from 'express';

const UNKNOWN_IP = 'unknown';

/**
 * The address to hold responsible for a request.
 *
 * The last hop of `X-Forwarded-For` on purpose, not the first: a reverse proxy
 * appends the address it actually saw, so the last entry is the one no client
 * can forge, while anything earlier in the list is whatever the caller sent.
 * With no proxy in front there is no header and the socket's address is used.
 */
export function clientIpOf(req: Request): string {
  const header = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.join(',') : header;

  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');
    const lastHop = hops[hops.length - 1];
    if (lastHop) return lastHop;
  }

  return req.socket.remoteAddress ?? UNKNOWN_IP;
}

/**
 * A client's address as the sign-in limiter's keys see it, so one network cannot get a fresh count by moving within
 * itself:
 *
 * - IPv4 as it is;
 * - an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as that IPv4 address;
 * - any other IPv6 address by its /64 network, written `a:b:c:d::/64`, with a zone id (`%eth0`) dropped;
 * - anything that does not parse, `unknown` among them, as it was sent.
 *
 * Only the keys use this form; log lines print the address as it was received. Nothing here imports node.
 */
export function limiterAddress(ip: string): string {
  if (ipv4Bytes(ip)) return ip;
  const groups = ipv6Groups(ip.split('%')[0] ?? '');
  if (!groups) return ip;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** The four bytes of a dotted IPv4 address, or null when it is not one. */
function ipv4Bytes(text: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

/** The eight 16-bit groups of an IPv6 address, `::` expanded and a trailing dotted IPv4 read as two, or null. */
function ipv6Groups(text: string): number[] | null {
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = groupsOf(halves[0] ?? '', !compressed);
  const tail = compressed ? groupsOf(halves[1] ?? '', true) : [];
  if (!head || !tail) return null;
  if (!compressed) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** The groups of one side of `::`; only the last piece of the whole address may be a dotted IPv4 address. */
function groupsOf(part: string, mayEndInIpv4: boolean): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  const pieces = part.split(':');
  for (const [index, piece] of pieces.entries()) {
    if (mayEndInIpv4 && index === pieces.length - 1 && piece.includes('.')) {
      const bytes = ipv4Bytes(piece);
      if (!bytes) return null;
      const [a = 0, b = 0, c = 0, d = 0] = bytes;
      groups.push((a << 8) | b, (c << 8) | d);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}
