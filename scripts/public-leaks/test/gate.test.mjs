/**
 * The public leak gate's rules, driven with placeholder values only. Every value that must be
 * refused is assembled while the test runs, so this file never carries one the gate would refuse.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateTokens, isAllowedIpv4, parseRules, scanText, secretHash, tokenHash } from '../lib.mjs';

const GATE = fileURLToPath(new URL('../gate.mjs', import.meta.url));
const DENY_LIST = fileURLToPath(new URL('../deny.sha256', import.meta.url));
const ALLOW_LIST = fileURLToPath(new URL('../allow.json', import.meta.url));

/** An address in public space that no documentation range covers, built here and never written down. */
const PUBLIC_ADDRESS = ['11', '22', '33', '44'].join('.');
/** A plausible wallet, built here: twenty bytes that are not one repeated digit. */
const REAL_LOOKING_WALLET = '0x' + '9a3f'.repeat(10);
const DENIED_TOKEN = ['leaky', 'host', 'name'].join('-');

function rulesWith({ allowed = [], allowedSecrets = [], homeUsers = [], denied = [] } = {}) {
  return parseRules({
    allowJson: JSON.stringify({
      ethereumAddresses: allowed.map((address) => ({ address, why: 'test' })),
      publishedSecrets: allowedSecrets.map((value) => ({ sha256: secretHash(value), why: 'test' })),
      homeUsers: homeUsers.map((name) => ({ name, why: 'test' })),
    }),
    denyText: denied.map(tokenHash).join('\n'),
  });
}

describe('IPv4 addresses', () => {
  it('lets documentation, private, loopback and example resolver addresses through', () => {
    for (const address of [
      '192.0.2.7',
      '198.51.100.9',
      '203.0.113.10',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '8.8.8.8',
      '1.1.1.1',
    ]) {
      assert.equal(isAllowedIpv4(address.split('.').map(Number)), true, address);
    }
  });

  it('refuses an address in public space', () => {
    const findings = scanText(`ssh deploy@${PUBLIC_ADDRESS}`, rulesWith());
    assert.deepEqual(findings, [{ rule: 'ipv4', line: 1, value: PUBLIC_ADDRESS }]);
  });

  it('lets through the private addresses fixtures and container defaults use', () => {
    const text = ['10.0.0.7', '10.42.0.1', '172.17.0.1', '172.18.0.4', '192.168.1.20', '192.168.0.0/16'].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });

  it('refuses a private address inside a range that describes one host', () => {
    const addresses = [
      ['10', '200', '0', '1'],
      ['10', '200', '255', '254'],
      ['192', '168', '65', '1'],
      ['192', '168', '65', '254'],
    ].map((octets) => octets.join('.'));
    for (const address of addresses) {
      assert.deepEqual(
        scanText(`gateway ${address}`, rulesWith()),
        [{ rule: 'host-private-ipv4', line: 1, value: address }],
        address,
      );
    }
  });

  it('refuses such a range written as a network', () => {
    const network = ['10', '200', '0', '0'].join('.');
    assert.deepEqual(scanText(`subnet: ${network}/16`, rulesWith()), [
      { rule: 'host-private-ipv4', line: 1, value: network },
    ]);
  });

  it('lets through the neighbours of each host range', () => {
    const text = ['10.199.255.255', '10.201.0.1', '192.168.64.1', '192.168.66.1'].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });

  it('reads an RFC section number, an octet over 255 and a longer dotted version as no address', () => {
    const text = [
      'RFC 8216 §4.3.2.6 says so',
      'section 4.3.3.3',
      'not an address: 256.1.1.1',
      'version 1.2.3.4.5',
    ].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });
});

describe('Ethereum addresses', () => {
  it('refuses an address that is not on the allow list', () => {
    const findings = scanText(`owner: ${REAL_LOOKING_WALLET}`, rulesWith());
    assert.deepEqual(findings, [{ rule: 'eth-address', line: 1, value: REAL_LOOKING_WALLET }]);
  });

  it('lets an allowed address through in any case', () => {
    assert.deepEqual(
      scanText(REAL_LOOKING_WALLET.toUpperCase().replace('0X', '0x'), rulesWith({ allowed: [REAL_LOOKING_WALLET] })),
      [],
    );
  });

  it('does not read the first forty digits of a 32-byte key as an address', () => {
    assert.deepEqual(scanText('0x' + '9a3f'.repeat(16), rulesWith()), []);
  });
});

/**
 * One made-up value per secret shape, assembled here so no line of this file has the shape itself.
 * None of them was ever issued by anybody.
 * @type {Record<string, string>}
 */
const SECRET_SHAPES = {
  'private-key-block': '-----' + 'BEGIN OPENSSH ' + 'PRIVATE KEY' + '-----',
  'aws-access-key': 'AKI' + 'A' + 'Z3Q7'.repeat(4),
  'github-token': 'gh' + 'p_' + 'a1B2'.repeat(9),
  'slack-token': 'xo' + 'xb-' + '1234567890-abcdefghij',
  'stripe-key': 'sk' + '_live_' + 'Zq9'.repeat(8),
  jwt: ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxIn0', 'c2lnbmF0dXJlLXN0dWI'].join('.'),
};

describe('secrets by shape', () => {
  for (const [rule, value] of Object.entries(SECRET_SHAPES)) {
    it(`refuses a ${rule}`, () => {
      assert.deepEqual(scanText(`token = "${value}"`, rulesWith()), [{ rule, line: 1, value }]);
    });
  }

  it('refuses the other private key headers and a fine-grained GitHub token', () => {
    const values = [
      '-----' + 'BEGIN RSA ' + 'PRIVATE KEY' + '-----',
      '-----' + 'BEGIN EC ' + 'PRIVATE KEY' + '-----',
      '-----' + 'BEGIN ' + 'PRIVATE KEY' + '-----',
      '-----' + 'BEGIN PGP ' + 'PRIVATE KEY BLOCK' + '-----',
      'github' + '_pat_' + 'Ab3_'.repeat(8),
      'gh' + 's_' + 'a1B2'.repeat(9),
      'rk' + '_live_' + 'Zq9'.repeat(8),
      'sk' + '_test_' + 'Zq9'.repeat(8),
    ];
    for (const value of values) assert.equal(scanText(value, rulesWith()).length, 1, `${value.length} characters`);
  });

  it('lets through a public key block, bare prefixes and words that only start the same way', () => {
    const text = [
      '-----' + 'BEGIN PUBLIC KEY' + '-----',
      '-----' + 'BEGIN CERTIFICATE' + '-----',
      'AKIA is the prefix of an access key id',
      'ghp_ starts a classic token',
      'sk_live_ starts a live key',
      'eyJ starts a JSON object in base64',
      'xoxb- starts a bot token',
    ].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });
});

/** Thirty-two made-up bytes, built here so no line of this file holds 64 hex digits. */
const KEY_HEX = 'c0ffee12'.repeat(8);

describe('64 hex digits beside a key word', () => {
  it('refuses them after a key, secret, private, seed, signer or wallet word', () => {
    for (const text of [
      `PRIVATE_KEY=0x${KEY_HEX}`,
      `const signerSecret = '${KEY_HEX}';`,
      `seed: ${KEY_HEX}`,
      `WALLET="${KEY_HEX}"`,
    ]) {
      const findings = scanText(text, rulesWith());
      assert.equal(findings.length, 1, text.replace(KEY_HEX, '<hex>'));
      assert.equal(findings[0].rule, 'keyed-hex-64');
    }
  });

  it('refuses them before a key word on the same line', () => {
    assert.equal(scanText(`${KEY_HEX} # the signer`, rulesWith()).length, 1);
  });

  it('lets through 64 hex digits with no key word near, and a key word too far away', () => {
    const text = [`topic: ${KEY_HEX}`, `key word first, then a long gap of padding text: ${KEY_HEX}`].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });

  it('lets through an image digest beside a secret word', () => {
    assert.deepEqual(scanText(`-e SECRET=$SECRET node:24-alpine@sha256:${KEY_HEX}`, rulesWith()), []);
  });

  it('lets through a published sample by its hash, with or without 0x and in any case', () => {
    const rules = rulesWith({ allowedSecrets: [KEY_HEX] });
    for (const text of [`PRIVATE_KEY=0x${KEY_HEX}`, `secret ${KEY_HEX.toUpperCase()}`]) {
      assert.deepEqual(scanText(text, rules), [], text.replace(/[0-9a-f]{64}/i, '<hex>'));
    }
  });

  it('keeps the committed allow list of published secrets as lowercase sha256 hashes', () => {
    const allow = JSON.parse(readFileSync(ALLOW_LIST, 'utf8'));
    assert.ok(allow.publishedSecrets.length > 0);
    for (const entry of allow.publishedSecrets) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      assert.ok(entry.why);
    }
  });

  it('refuses an allow list entry that is not a lowercase sha256', () => {
    assert.throws(
      () =>
        parseRules({
          allowJson: JSON.stringify({ ethereumAddresses: [], publishedSecrets: [{ sha256: 'nope', why: 'x' }] }),
          denyText: '',
        }),
      /lowercase sha256/,
    );
  });
});

/** The rules the committed lists give, for the cases that hinge on what the repository allows. */
function committedRules() {
  return parseRules({ allowJson: readFileSync(ALLOW_LIST, 'utf8'), denyText: readFileSync(DENY_LIST, 'utf8') });
}

describe('home folders', () => {
  const person = ['ali', 'ce'].join('');

  it('refuses a home folder on macOS and on Linux that names a person', () => {
    for (const path of [`/${'Users'}/${person}/project`, `/${'home'}/${person}/.ssh`, `HOME=/${'home'}/${person}`]) {
      const findings = scanText(path, rulesWith());
      assert.equal(findings.length, 1, path);
      assert.equal(findings[0].rule, 'home-path');
    }
  });

  it('lets through the role users the committed allow list names', () => {
    const text = [
      `/${'home'}/bee/.bee`,
      `/${'home'}/deploy/streaming`,
      `ps line for /${'Users'}/x/chrome`,
    ].join('\n');
    assert.deepEqual(scanText(text, committedRules()), []);
  });

  it('lets through a placeholder, a bare root and a longer path that only contains one', () => {
    const text = ['/Users/<name>/', '/home/', '/home/$USER/', 'var/lib/home/data'].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });

  it('refuses a person even when a role user shares the prefix', () => {
    const findings = scanText(`/${'home'}/beekeeper/`, rulesWith({ homeUsers: ['bee'] }));
    assert.equal(findings.length, 1);
  });
});

describe('email addresses', () => {
  it('refuses an address at a real-looking domain', () => {
    for (const domain of ['personal-mail.net', 'some-company.io', 'mail.some-company.co.uk']) {
      const address = 'jane.doe' + '@' + domain;
      assert.deepEqual(scanText(`contact ${address}`, rulesWith()), [{ rule: 'email', line: 1, value: address }]);
    }
  });

  it('lets through the reserved example domains and the GitHub SSH user', () => {
    const text = [
      'ops@example.com',
      'a@admin.example.org',
      'b@example.net',
      'c@bee.example.invalid',
      'd@funding.example.test',
      'e@admin.offline.example',
      'f@app.localhost',
      'git clone git@github.com:owner/repo.git',
    ].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });

  it('lets through package versions, scopes and a user at a bare host', () => {
    const text = ['pnpm add left-pad@1.3.0', 'import x from "@scope/name"', 'ssh deploy@bastion'].join('\n');
    assert.deepEqual(scanText(text, rulesWith()), []);
  });

  it('refuses a domain that only starts like an example one', () => {
    const address = 'ops' + '@' + 'example.com.attacker.net';
    assert.equal(scanText(address, rulesWith()).length, 1);
  });
});

describe('the hashed deny list', () => {
  it('refuses a denied token wherever it stands in a longer run', () => {
    const rules = rulesWith({ denied: [DENIED_TOKEN] });
    for (const text of [
      DENIED_TOKEN,
      `ssh ${DENIED_TOKEN}`,
      `deploy@${DENIED_TOKEN}.example.org`,
      DENIED_TOKEN.toUpperCase(),
    ]) {
      assert.equal(scanText(text, rules).length, 1, text);
    }
  });

  it('refuses a denied domain inside a subdomain', () => {
    const domain = ['leaky', 'example', 'net'].join('.');
    const rules = rulesWith({ denied: [domain] });
    assert.equal(scanText(`https://admin.${domain}/login`, rules).length, 1);
  });

  it('lets a token through that only contains a denied one inside a word', () => {
    const rules = rulesWith({ denied: ['leaky'] });
    assert.deepEqual(scanText('leakyness', rules), []);
  });

  it('refuses a hosted issue tracker link through the committed list', () => {
    const link = `https://team.${'atlas' + 'sian'}.net/browse/ABC-1`;
    assert.equal(scanText(link, committedRules()).filter((finding) => finding.rule === 'denied-token').length, 1);
  });

  it('offers every contiguous span of a run', () => {
    assert.deepEqual(candidateTokens('a-b.c'), ['a', 'a-b', 'a-b.c', 'b', 'b.c', 'c']);
  });

  it('keeps the committed deny list sorted and free of repeats', () => {
    const hashes = readFileSync(DENY_LIST, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(hashes, [...new Set(hashes)].sort());
  });

  it('refuses a deny list line that is not a lowercase sha256', () => {
    assert.throws(
      () => parseRules({ allowJson: '{"ethereumAddresses":[]}', denyText: 'not-a-hash' }),
      /lowercase sha256/,
    );
  });
});

describe('the command, on a repository of its own', () => {
  function repositoryWith(files) {
    const root = mkdtempSync(join(tmpdir(), 'public-leaks-'));
    execFileSync('git', ['init', '-q', root]);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    execFileSync('git', ['-C', root, 'add', '.']);
    return root;
  }

  it('passes a tree of placeholders', () => {
    const root = repositoryWith({ 'README.md': 'Point it at 203.0.113.7 and admin.example.org.\n' });
    try {
      const run = spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('goes red on a planted host range address and names it', () => {
    const address = ['192', '168', '65', '1'].join('.');
    const root = repositoryWith({ 'compose.yml': `extra_hosts:\n  - "bee:${address}"\n` });
    try {
      const run = spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout, new RegExp(`compose\\.yml:2: host-private-ipv4: ${address.replaceAll('.', '\\.')}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('goes red on a planted public address and a planted wallet, and names each', () => {
    const root = repositoryWith({ 'notes.md': `host ${PUBLIC_ADDRESS}\nwallet ${REAL_LOOKING_WALLET}\n` });
    try {
      const run = spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout, new RegExp(`notes\\.md:1: ipv4: ${PUBLIC_ADDRESS.replaceAll('.', '\\.')}`));
      assert.match(run.stdout, new RegExp(`notes\\.md:2: eth-address: ${REAL_LOOKING_WALLET}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('goes red on a planted secret and names its kind and length, never the value', () => {
    const token = SECRET_SHAPES['github-token'];
    const root = repositoryWith({ 'notes.md': `export GH_TOKEN=${token}\n` });
    try {
      const run = spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout, new RegExp(`notes\\.md:1: github-token: a value of ${token.length} characters`));
      assert.equal(run.stdout.includes(token), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
