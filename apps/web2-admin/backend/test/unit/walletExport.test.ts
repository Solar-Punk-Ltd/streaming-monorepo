/**
 * `wallet:export`, the brand wallet's backup at handover. Unit test, with the wallet's row in memory; the command's
 * own database is never opened. `pnpm test`.
 *
 * Whoever holds the key can move the wallet's funds, so what is pinned here is that the command refuses without its
 * confirmation, before it reads anything, and that with it the key is printed once, alone on standard output, after
 * a warning that says what it is.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';

import { type BackupOutput, printBrandWalletBackup, runWalletExport } from '../../src/cli/walletExport.js';
import { BrandWallet } from '../../src/domain/funding/BrandWallet.js';

import { InMemoryBrandWalletStore } from './support/brandWalletFakes.js';

const SECRET = randomBytes(32).toString('hex');

/** An output that keeps what each stream was given, line by line. */
function captured(): BackupOutput & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => void outLines.push(line),
    err: (line) => void errLines.push(line),
  };
}

describe('wallet:export', () => {
  it('refuses without --i-understand, or with anything beside it, before it reads the config', async () => {
    for (const argv of [[], ['--yes'], ['--i-understand=yes'], ['--i-understand', 'now'], ['now']]) {
      await assert.rejects(runWalletExport(argv), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /--i-understand/, argv.join(' '));
        assert.doesNotMatch(error.message, /env var/i, 'it read the config before refusing');
        return true;
      });
    }
  });

  it('prints the key once, alone on standard output, after a warning that says what it is', async () => {
    const store = new InMemoryBrandWalletStore();
    const address = (await BrandWallet.start(store, SECRET)).address();
    const output = captured();

    await printBrandWalletBackup(store, SECRET, output);

    assert.equal(output.outLines.length, 1, 'standard output holds more than the key');
    const key = output.outLines[0]!;
    assert.match(key, /^0x[0-9a-f]{64}$/);
    assert.equal(privateKeyToAddress(key as Hex).toLowerCase(), address, "the key printed is not the wallet's");
    const warning = output.errLines.join('\n');
    assert.match(warning, /backup/i);
    assert.match(warning, /handover/i);
    assert.match(warning, /anyone who holds it can move/i);
    assert.ok(address && warning.includes(address), 'the warning does not name the address');
    assert.equal(warning.toLowerCase().includes(key.slice(2)), false, 'the key is on standard error as well');
  });

  it('prints nothing when the wallet cannot be opened', async () => {
    const store = new InMemoryBrandWalletStore();
    await BrandWallet.start(store, SECRET);
    for (const [what, from, secret] of [
      ['no secret', store, null],
      ['another secret', store, randomBytes(32).toString('hex')],
      ['no wallet', new InMemoryBrandWalletStore(), SECRET],
    ] as const) {
      const output = captured();

      await assert.rejects(printBrandWalletBackup(from, secret, output), what);

      assert.deepEqual([output.outLines, output.errLines], [[], []], what);
    }
  });

  it('is a package script beside user:add, as pnpm wallet:export', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };

    assert.match(manifest.scripts['wallet:export'] ?? '', /src\/cli\.ts wallet:export$/);
  });
});
