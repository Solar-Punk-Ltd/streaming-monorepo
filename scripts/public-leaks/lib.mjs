/**
 * The rules of the public leak gate, as pure functions over text, so the tests can drive them with
 * placeholder fixtures and the command line only has to list files.
 *
 * These fail a file: an IPv4 address outside the ranges documentation and private networks use, a
 * private address inside one of the few ranges that describe a single host's setup, an Ethereum
 * address that is not on the allow list of known fakes and public contracts, a token whose sha256 is
 * on the deny list, and a value shaped like a secret: a private key block, a token in the format a
 * known issuer uses, or 64 hex digits beside a word such as key or secret, a home folder that names
 * a person rather than a role user, and an email address outside the reserved example domains. The
 * deny list and the
 * allow list of published sample secrets hold hashes only, so neither names what it lists.
 */
import { createHash } from 'node:crypto';

/** @typedef {'private-key-block' | 'aws-access-key' | 'github-token' | 'slack-token' | 'stripe-key' | 'jwt'} SecretShapeRule */
/** @typedef {{ rule: 'ipv4' | 'host-private-ipv4' | 'eth-address' | 'denied-token' | 'keyed-hex-64' | 'home-path' | 'email' | SecretShapeRule, line: number, value: string }} Finding */
/** @typedef {{ allowedAddresses: Set<string>, allowedSecretHashes: Set<string>, homeUsers: Set<string>, deniedHashes: Set<string> }} Rules */

const IPV4 = /(?<![\w.§])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g;
const SECTION_BEFORE = /(§|\bsection\s|\bRFC\s?\d+\s)$/i;
const ETH_ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const TOKEN_RUN = /[A-Za-z0-9][A-Za-z0-9._@-]*/g;
const TOKEN_SEPARATOR = /[._@-]/;
const MAX_PARTS_PER_RUN = 12;
/**
 * Secrets recognised by the format their issuer gives them. Each pattern needs the whole value, so
 * a prefix named in prose, such as `ghp_` alone, passes.
 * @type {ReadonlyArray<{ rule: SecretShapeRule, pattern: RegExp }>}
 */
const SECRET_SHAPES = [
  { rule: 'private-key-block', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/g },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { rule: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
];
/** A 32-byte value written as hex, the size of a private key, a wallet secret or a seed. */
const HEX_64 = /(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
const KEY_WORD = /key|secret|private|seed|signer|wallet/i;
/** How far either side of a 64-hex value a key word makes it a secret. */
const KEY_WORD_REACH = 40;
/** A content digest, which is public by design. */
const DIGEST_BEFORE = /sha256:$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A home folder on macOS or Linux, standing at the start of a path rather than inside a longer one. */
const HOME_PATH = /(?<![\w.~/-])\/(?:Users|home)\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/g;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
/** The second-level domains RFC 2606 reserves for examples. */
const EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org'];
/** The top-level names RFC 2606 and RFC 6761 reserve, which never reach a real mailbox. */
const RESERVED_TOP_LEVEL = new Set(['example', 'invalid', 'test', 'localhost']);
/** The SSH user of every GitHub clone URL stands at this domain, and it is not a person. */
const SERVICE_EMAIL_DOMAINS = new Set(['github.com']);

/**
 * Whether an email address at this domain can be left in the public tree: a reserved example
 * domain, or a service's own SSH user.
 * @param {string} domain
 */
export function isExampleEmailDomain(domain) {
  const lower = domain.toLowerCase();
  if (SERVICE_EMAIL_DOMAINS.has(lower)) return true;
  if (RESERVED_TOP_LEVEL.has(lower.slice(lower.lastIndexOf('.') + 1))) return true;
  return EXAMPLE_DOMAINS.some((example) => lower === example || lower.endsWith(`.${example}`));
}

/** The shortest and longest token the deny list is checked against. */
const MIN_TOKEN_LENGTH = 3;
const MAX_TOKEN_LENGTH = 128;

/**
 * Private ranges that are not neutral: an address in one of them describes how one particular host
 * was set up rather than a default every reader shares. Listed by hand, never guessed. A network is
 * written as octets so this file never carries an address the gate itself would refuse.
 * @type {ReadonlyArray<{ network: number[], prefixLength: number, why: string }>}
 */
export const HOST_SPECIFIC_PRIVATE_RANGES = [
  { network: [10, 200, 0, 0], prefixLength: 16, why: 'a custom Docker address pool chosen for one host' },
  { network: [192, 168, 65, 0], prefixLength: 24, why: 'the virtual machine range of Docker Desktop on a laptop' },
];

/** @param {number[]} octets */
function ipv4Number(octets) {
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

/**
 * Whether an IPv4 address falls in one of the private ranges that describe a single host.
 * @param {number[]} octets
 */
export function isHostSpecificPrivateIpv4(octets) {
  const address = ipv4Number(octets);
  return HOST_SPECIFIC_PRIVATE_RANGES.some(({ network, prefixLength }) => {
    const size = 2 ** (32 - prefixLength);
    const start = ipv4Number(network);
    return address >= start && address < start + size;
  });
}

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

/**
 * The sha256 of a 64-hex secret, written lowercase and without `0x`, which is what the allow list of
 * published sample secrets holds.
 * @param {string} hex
 */
export function secretHash(hex) {
  return createHash('sha256').update(hex.toLowerCase().replace(/^0x/, '')).digest('hex');
}

/**
 * Whether a key word stands within reach of the value at `start` to `end` on this line.
 * @param {string} line
 * @param {number} start
 * @param {number} end
 */
function hasKeyWordNear(line, start, end) {
  const before = line.slice(Math.max(0, start - KEY_WORD_REACH), start);
  const after = line.slice(end, end + KEY_WORD_REACH);
  return KEY_WORD.test(before) || KEY_WORD.test(after);
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
      if (isHostSpecificPrivateIpv4(octets)) {
        findings.push({ rule: 'host-private-ipv4', line: index + 1, value: match[0] });
      } else if (!isAllowedIpv4(octets)) {
        findings.push({ rule: 'ipv4', line: index + 1, value: match[0] });
      }
    }
    for (const match of line.matchAll(ETH_ADDRESS)) {
      if (!rules.allowedAddresses.has(match[0].toLowerCase())) {
        findings.push({ rule: 'eth-address', line: index + 1, value: match[0] });
      }
    }
    for (const match of line.matchAll(HOME_PATH)) {
      if (!rules.homeUsers.has(match[1])) findings.push({ rule: 'home-path', line: index + 1, value: match[0] });
    }
    for (const match of line.matchAll(EMAIL)) {
      if (!isExampleEmailDomain(match[1])) findings.push({ rule: 'email', line: index + 1, value: match[0] });
    }
    for (const match of line.matchAll(HEX_64)) {
      const end = match.index + match[0].length;
      if (DIGEST_BEFORE.test(line.slice(0, match.index))) continue;
      if (!hasKeyWordNear(line, match.index, end)) continue;
      if (rules.allowedSecretHashes.has(secretHash(match[1]))) continue;
      findings.push({ rule: 'keyed-hex-64', line: index + 1, value: match[0] });
    }
    for (const { rule, pattern } of SECRET_SHAPES) {
      for (const match of line.matchAll(pattern)) findings.push({ rule, line: index + 1, value: match[0] });
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
 * The rules from the two committed files: the allow list's addresses, published secret hashes and
 * role users, and the deny list's hashes, one per line, with `#` starting a comment.
 * @param {{ allowJson: string, denyText: string }} sources
 * @returns {Rules}
 */
export function parseRules({ allowJson, denyText }) {
  const allow = JSON.parse(allowJson);
  const allowedAddresses = new Set(allow.ethereumAddresses.map((entry) => entry.address.toLowerCase()));
  const allowedSecretHashes = new Set();
  for (const { sha256 } of allow.publishedSecrets ?? []) {
    if (!SHA256_HEX.test(sha256)) throw new Error(`allow list secret is not a lowercase sha256: ${sha256}`);
    allowedSecretHashes.add(sha256);
  }
  const homeUsers = new Set((allow.homeUsers ?? []).map((entry) => entry.name));
  const deniedHashes = new Set();
  for (const raw of denyText.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (!SHA256_HEX.test(line)) throw new Error(`deny list line is not a lowercase sha256: ${raw}`);
    deniedHashes.add(line);
  }
  return { allowedAddresses, allowedSecretHashes, homeUsers, deniedHashes };
}
