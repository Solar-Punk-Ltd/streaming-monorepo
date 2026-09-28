/**
 * The rules of the public leak gate, as pure functions over text, so the tests can drive them with
 * placeholder fixtures and the command line only has to list files.
 *
 * Three things fail a file: an IPv4 address outside the ranges documentation and private networks
 * use, an Ethereum address that is not on the allow list of known fakes and public contracts, and a
 * token whose sha256 is on the deny list. The deny list holds hashes only, so it names nothing it
 * refuses.
 */
import { createHash } from 'node:crypto';

/** @typedef {{ rule: 'ipv4' | 'eth-address' | 'denied-token', line: number, value: string }} Finding */
/** @typedef {{ allowedAddresses: Set<string>, deniedHashes: Set<string> }} Rules */

const IPV4 = /(?<![\w.§])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g;
const SECTION_BEFORE = /(§|\bsection\s|\bRFC\s?\d+\s)$/i;
const ETH_ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const TOKEN_RUN = /[A-Za-z0-9][A-Za-z0-9._@-]*/g;
const TOKEN_SEPARATOR = /[._@-]/;
const MAX_PARTS_PER_RUN = 12;
/** The shortest and longest token the deny list is checked against. */
const MIN_TOKEN_LENGTH = 3;
const MAX_TOKEN_LENGTH = 128;

/** Well-known public resolvers, which examples name. */
const PUBLIC_EXAMPLE_ADDRESSES = new Set(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9']);

/**
 * Whether an IPv4 address may appear in the public tree: documentation (RFC 5737), private
 * (RFC 1918), shared (RFC 6598), loopback, link-local, benchmarking, unspecified, multicast and
 * broadcast ranges, and the public resolvers examples use.
 * @param {number[]} octets
 */
export function isAllowedIpv4(octets) {
  const [a, b, c] = octets;
  if (PUBLIC_EXAMPLE_ADDRESSES.has(octets.join('.'))) return true;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/** The lowercase sha256 of a token, which is what the deny list holds. */
export function tokenHash(token) {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

/**
 * Every candidate a run of word characters offers: the run itself and each contiguous span of its
 * parts, split at dots, at signs, hyphens and underscores. So `ssh-user@203.0.113.9` offers
 * `ssh-user`, `203.0.113.9` and every other span, and `a.b.example.org` offers `example.org`.
 * @param {string} run
 * @returns {string[]}
 */
export function candidateTokens(run) {
  const trimmed = run.replace(/[._@-]+$/, '');
  const pieces = trimmed.split(/([._@-])/);
  const parts = [];
  for (let index = 0; index < pieces.length; index += 2) parts.push(pieces[index]);
  if (parts.length > MAX_PARTS_PER_RUN) return [trimmed];
  const candidates = [];
  for (let start = 0; start < parts.length; start += 1) {
    let text = '';
    for (let end = start; end < parts.length; end += 1) {
      text += end === start ? parts[end] : pieces[end * 2 - 1] + parts[end];
      if (text) candidates.push(text);
    }
  }
  return candidates;
}

/**
 * The findings in one file's text. `hashCache` is shared across files, because a tree repeats most
 * of its tokens and hashing is the whole cost.
 * @param {string} text
 * @param {Rules} rules
 * @param {Map<string, boolean>} [hashCache]
 * @returns {Finding[]}
 */
export function scanText(text, rules, hashCache = new Map()) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(IPV4)) {
      const octets = match.slice(1, 5).map(Number);
      if (match.slice(1, 5).some((octet) => octet.length > 1 && octet.startsWith('0'))) continue;
      if (octets.some((octet) => octet > 255)) continue;
      if (SECTION_BEFORE.test(line.slice(0, match.index))) continue;
      if (!isAllowedIpv4(octets)) findings.push({ rule: 'ipv4', line: index + 1, value: match[0] });
    }
    for (const match of line.matchAll(ETH_ADDRESS)) {
      if (!rules.allowedAddresses.has(match[0].toLowerCase())) {
        findings.push({ rule: 'eth-address', line: index + 1, value: match[0] });
      }
    }
    if (rules.deniedHashes.size === 0) continue;
    for (const run of line.matchAll(TOKEN_RUN)) {
      const candidates = TOKEN_SEPARATOR.test(run[0]) ? candidateTokens(run[0]) : [run[0]];
      for (const candidate of candidates) {
        if (candidate.length < MIN_TOKEN_LENGTH || candidate.length > MAX_TOKEN_LENGTH) continue;
        const key = candidate.toLowerCase();
        let denied = hashCache.get(key);
        if (denied === undefined) {
          denied = rules.deniedHashes.has(tokenHash(key));
          hashCache.set(key, denied);
        }
        if (denied) findings.push({ rule: 'denied-token', line: index + 1, value: candidate });
      }
    }
  }
  return findings;
}

/**
 * The rules from the two committed files: the allow list's addresses, and the deny list's hashes,
 * one per line, with `#` starting a comment.
 * @param {{ allowJson: string, denyText: string }} sources
 * @returns {Rules}
 */
export function parseRules({ allowJson, denyText }) {
  const allow = JSON.parse(allowJson);
  const allowedAddresses = new Set(allow.ethereumAddresses.map((entry) => entry.address.toLowerCase()));
  const deniedHashes = new Set();
  for (const raw of denyText.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (!/^[0-9a-f]{64}$/.test(line)) throw new Error(`deny list line is not a lowercase sha256: ${raw}`);
    deniedHashes.add(line);
  }
  return { allowedAddresses, deniedHashes };
}
