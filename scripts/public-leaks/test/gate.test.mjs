/**
 * The public leak gate's rules, driven with placeholder values only. Every value that must be
 * refused is assembled while the test runs, so this file never carries one the gate would refuse.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateTokens, isAllowedIpv4, parseRules, scanText, tokenHash } from '../lib.mjs';

const GATE = fileURLToPath(new URL('../gate.mjs', import.meta.url));

/** An address in public space that no documentation range covers, built here and never written down. */
const PUBLIC_ADDRESS = ['11', '22', '33', '44'].join('.');
/** A plausible wallet, built here: twenty bytes that are not one repeated digit. */
const REAL_LOOKING_WALLET = '0x' + '9a3f'.repeat(10);
const DENIED_TOKEN = ['leaky', 'host', 'name'].join('-');

function rulesWith({ allowed = [], denied = [] } = {}) {
  return parseRules({
    allowJson: JSON.stringify({ ethereumAddresses: allowed.map((address) => ({ address, why: 'test' })) }),
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

  it('offers every contiguous span of a run', () => {
    assert.deepEqual(candidateTokens('a-b.c'), ['a', 'a-b', 'a-b.c', 'b', 'b.c', 'c']);
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
});
