/**
 * BrandWalletRepository, and the brand wallet over it, against the real database (migration 015). Needs Postgres,
 * like the rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that migration 015 applied; that `brand_wallet` holds one wallet and no
 * other; that a second insert leaves the first wallet as it was and answers it; that two starts, or two inserts,
 * racing on an empty table end with one wallet; that a wallet created through Postgres opens at the next start; and
 * that the CHECKs refuse an address that is not 0x and 40 hex digits in lower case, and a key, IV or tag of another
 * length.
 *
 * Every row it writes is in the suite's throwaway database; it empties the table before each test. Every key is
 * generated for the run.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

import { Database } from '../../src/domain/Database.js';
import { BrandWallet, exportBrandWalletKey } from '../../src/domain/funding/BrandWallet.js';
import { BrandWalletRepository, type NewBrandWalletRow } from '../../src/domain/funding/BrandWalletRepository.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let wallets: BrandWalletRepository;

const SECRET = randomBytes(32).toString('hex');

/**
 * A row of the shape migration 015 takes, with `changes`: the address of a key made for the run, beside bytes of the
 * right lengths that are no sealed key, since the repository stores what it is given.
 */
function walletRow(changes: Partial<NewBrandWalletRow> = {}): NewBrandWalletRow {
  return {
    address: privateKeyToAddress(generatePrivateKey()).toLowerCase() as Address,
    keyCiphertext: randomBytes(32),
    keyIv: randomBytes(12),
    keyAuthTag: randomBytes(16),
    ...changes,
  };
}

/** Inserts `row` past the repository, under `id` when one is given, for what the table itself refuses. */
function insertDirectly(row: NewBrandWalletRow, id?: boolean) {
  const columns = ['address', 'key_ciphertext', 'key_iv', 'key_auth_tag'];
  const values: unknown[] = [row.address, row.keyCiphertext, row.keyIv, row.keyAuthTag];
  if (id !== undefined) {
    columns.unshift('id');
    values.unshift(id);
  }
  const placeholders = values.map((_value, index) => `$${index + 1}`).join(', ');
  return database.pool.query(`INSERT INTO brand_wallet (${columns.join(', ')}) VALUES (${placeholders})`, values);
}

async function walletCount(): Promise<number> {
  const result = await database.pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM brand_wallet');
  return result.rows[0]?.count ?? 0;
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  wallets = new BrandWalletRepository(database.pool);
});

after(async () => {
  if (!database) {
    await releaseStack();
    return;
  }
  await database.close();
  await releaseStack();
});

beforeEach(async () => {
  // The instance makes a wallet at its own start when its environment sets BRAND_WALLET_SECRET. Each test starts
  // with none.
  await database.pool.query('DELETE FROM brand_wallet');
});

describe('migration 015, brand_wallet', () => {
  it('is applied', async () => {
    const ledger = await database.pool.query<{ name: string }>(
      "SELECT name FROM _migrations WHERE name = '015_brand_wallet.sql'",
    );
    const table = await database.pool.query<{ found: string | null }>("SELECT to_regclass('brand_wallet') AS found");

    assert.equal(ledger.rows.length, 1);
    assert.equal(table.rows[0]?.found, 'brand_wallet');
  });

  it('holds one wallet and no other', async () => {
    await wallets.insertIfNone(walletRow());

    await assert.rejects(insertDirectly(walletRow()), { code: '23505' }, 'a second row under the one key');
    await assert.rejects(insertDirectly(walletRow(), false), { code: '23514' }, 'a row under another key');

    assert.equal(await walletCount(), 1);
  });

  it('refuses an address that is not 0x and 40 hex digits in lower case', async () => {
    const address = walletRow().address;
    for (const malformed of [`0xA${address.slice(3)}`, address.slice(2), `${address}00`, address.slice(0, 41), '']) {
      await assert.rejects(insertDirectly(walletRow({ address: malformed as Address })), { code: '23514' }, malformed);
    }

    assert.equal(await walletCount(), 0);
  });

  it('refuses a key, an IV or a tag of another length', async () => {
    for (const [what, changes] of [
      ['a key of 31 bytes', { keyCiphertext: randomBytes(31) }],
      ['a key of 33 bytes', { keyCiphertext: randomBytes(33) }],
      ['an IV of 11 bytes', { keyIv: randomBytes(11) }],
      ['an IV of 16 bytes', { keyIv: randomBytes(16) }],
      ['a tag of 12 bytes', { keyAuthTag: randomBytes(12) }],
      ['a tag of 17 bytes', { keyAuthTag: randomBytes(17) }],
    ] as const) {
      await assert.rejects(insertDirectly(walletRow(changes)), { code: '23514' }, what);
    }

    assert.equal(await walletCount(), 0);
  });
});

describe('BrandWalletRepository', () => {
  it('finds no wallet before one is stored', async () => {
    assert.equal(await wallets.find(), null);
  });

  it('stores a wallet and reads it back byte for byte, with the moment the database gave it', async () => {
    const row = walletRow();

    const stored = await wallets.insertIfNone(row);

    assert.equal(stored.address, row.address);
    assert.deepEqual(
      [stored.keyCiphertext, stored.keyIv, stored.keyAuthTag],
      [row.keyCiphertext, row.keyIv, row.keyAuthTag],
    );
    assert.ok(stored.createdAt instanceof Date);
    assert.deepEqual(await wallets.find(), stored);
  });

  it('leaves the first wallet untouched on a second insert, and answers it', async () => {
    const first = await wallets.insertIfNone(walletRow());

    const answered = await wallets.insertIfNone(walletRow());

    assert.deepEqual(answered, first);
    assert.deepEqual(await wallets.find(), first);
    assert.equal(await walletCount(), 1);
  });

  it('stores one of two inserts racing on an empty table, and both answer it', async () => {
    const rows = [walletRow(), walletRow()];

    const answers = await Promise.all(rows.map((row) => wallets.insertIfNone(row)));

    assert.equal(await walletCount(), 1);
    assert.equal(answers[0]?.address, answers[1]?.address);
    assert.ok(
      rows.some((row) => row.address === answers[0]?.address),
      'the stored wallet is neither of the two',
    );
  });
});

describe('the brand wallet over Postgres', () => {
  it('opens the wallet it created at the next start, and exports the key of its address', async () => {
    const created = await BrandWallet.start(wallets, SECRET);

    const reopened = await BrandWallet.start(new BrandWalletRepository(database.pool), SECRET);
    const { address, privateKey } = await exportBrandWalletKey(wallets, SECRET);

    assert.match(created.address() ?? '', /^0x[0-9a-f]{40}$/);
    assert.equal(reopened.address(), created.address());
    assert.equal(address, created.address());
    assert.equal(privateKeyToAddress(privateKey).toLowerCase(), created.address());
  });

  it('ends with one wallet when two starts race on an empty table, and both opened it', async () => {
    const [one, another] = await Promise.all([
      BrandWallet.start(new BrandWalletRepository(database.pool), SECRET),
      BrandWallet.start(new BrandWalletRepository(database.pool), SECRET),
    ]);

    const stored = await wallets.find();
    assert.equal(await walletCount(), 1);
    assert.equal(one.address(), stored?.address);
    assert.equal(another.address(), stored?.address);
  });
});
