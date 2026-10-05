/**
 * The brand wallet: made once, on the first start with BRAND_WALLET_SECRET set, its private key kept in the database
 * encrypted under that secret, and opened only to sign. Unit test, with the wallet's row in memory. `pnpm test`.
 *
 * What is pinned here: the key goes into the store encrypted and comes back whole under that secret and no other; a
 * start whose secret does not open the stored wallet stops; a signed transfer is the transaction it was asked for,
 * sent from the wallet's address; and neither the key nor the secret reaches a log line, an error or the wallet
 * object. Every key here is generated for the run.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

import {
  BrandWallet,
  BrandWalletError,
  type BrandWalletTransaction,
  exportBrandWalletKey,
} from '../../src/domain/funding/BrandWallet.js';

import { InMemoryBrandWalletStore } from './support/brandWalletFakes.js';

const SECRET = randomBytes(32).toString('hex');
const OTHER_SECRET = randomBytes(32).toString('hex');

/** A node's wallet, the address of a key made for this run. */
const NODE_WALLET = privateKeyToAddress(generatePrivateKey()).toLowerCase() as Address;

/** The public BZZ token contract on Gnosis Chain, which an xBZZ transfer calls. */
const BZZ_TOKEN: Address = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';

const GNOSIS = 100;

/** An xDAI transfer as the funding service builds one, value to a node's wallet and no call data, with `changes`. */
function transfer(changes: Partial<BrandWalletTransaction> = {}): BrandWalletTransaction {
  return {
    chainId: GNOSIS,
    nonce: 7,
    to: NODE_WALLET,
    value: 25n * 10n ** 16n,
    data: '0x',
    gas: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...changes,
  };
}

/** Every line logged while `run` ran, at any level. */
async function logged(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const methods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => mock.method(console, name, keep));
  try {
    await run();
  } finally {
    for (const method of methods) method.mock.restore();
  }
  return lines;
}

/** What `run` threw. Fails the test when it threw nothing. */
async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const error = await run().then(
    () => assert.fail('it was taken'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof Error, String(error));
  return error;
}

/** Who signed a transaction the wallet serialized: `0x02` and an EIP-1559 transaction's RLP. */
async function senderOf(signed: Hex): Promise<string> {
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerializedEIP1559 });
  return sender.toLowerCase();
}

/** Whether `text` holds one of these hex secrets, in either case, with or without its 0x. */
function holdsAny(text: string, secrets: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return secrets.some((secret) => lower.includes(secret.replace(/^0x/, '').toLowerCase()));
}

describe('BrandWallet.start', () => {
  it('creates the wallet on the first start with a secret, and stores its key only encrypted', async () => {
    const store = new InMemoryBrandWalletStore();

    const wallet = await BrandWallet.start(store, SECRET);

    const address = wallet.address();
    assert.match(address ?? '', /^0x[0-9a-f]{40}$/);
    const row = store.row;
    assert.ok(row, 'no row was stored');
    assert.equal(row.address, address);
    assert.equal(row.keyCiphertext.length, 32);
    assert.equal(row.keyIv.length, 12);
    assert.equal(row.keyAuthTag.length, 16);
    const { privateKey } = await exportBrandWalletKey(store, SECRET);
    assert.equal(privateKeyToAddress(privateKey).toLowerCase(), address, "the key that comes back is not the wallet's");
    assert.equal(
      row.keyCiphertext.equals(Buffer.from(privateKey.slice(2), 'hex')),
      false,
      'the key is stored in clear',
    );
  });

  it('opens the same wallet on every later start, and makes no other', async () => {
    const store = new InMemoryBrandWalletStore();
    const first = await BrandWallet.start(store, SECRET);

    const second = await BrandWallet.start(store, SECRET.toUpperCase());

    assert.equal(second.address(), first.address());
    assert.equal(store.inserts, 1);
  });

  it('encrypts each wallet under an IV of its own', async () => {
    const one = new InMemoryBrandWalletStore();
    const another = new InMemoryBrandWalletStore();

    await BrandWallet.start(one, SECRET);
    await BrandWallet.start(another, SECRET);

    assert.notEqual(one.row?.address, another.row?.address);
    assert.equal(one.row?.keyIv.equals(another.row?.keyIv ?? Buffer.alloc(0)), false);
  });

  it('makes one wallet when two starts race on an empty database', async () => {
    const store = new InMemoryBrandWalletStore();

    const [one, another] = await Promise.all([BrandWallet.start(store, SECRET), BrandWallet.start(store, SECRET)]);

    assert.equal(store.inserts, 2, 'both found no wallet and made one');
    assert.equal(one.address(), store.row?.address);
    assert.equal(another.address(), store.row?.address);
  });

  it('stops a start whose secret does not open the stored wallet, naming neither the key nor the secret', async () => {
    const store = new InMemoryBrandWalletStore();
    await BrandWallet.start(store, SECRET);
    const { privateKey } = await exportBrandWalletKey(store, SECRET);

    const error = await refusal(() => BrandWallet.start(store, OTHER_SECRET));

    assert.ok(error instanceof BrandWalletError);
    assert.match(error.message, /BRAND_WALLET_SECRET/);
    assert.equal(holdsAny(`${error.message}\n${error.stack}`, [SECRET, OTHER_SECRET, privateKey]), false);
  });

  it('stops a start when the stored row was changed: a byte of the key, its tag or its IV, or the address', async () => {
    const changes: [string, (store: InMemoryBrandWalletStore) => void][] = [
      ['a byte of the key', (store) => void (store.row!.keyCiphertext[0]! ^= 1)],
      ['a byte of the tag', (store) => void (store.row!.keyAuthTag[15]! ^= 1)],
      ['a byte of the IV', (store) => void (store.row!.keyIv[0]! ^= 1)],
      ['the address', (store) => void (store.row!.address = NODE_WALLET)],
    ];
    for (const [what, change] of changes) {
      const store = new InMemoryBrandWalletStore();
      await BrandWallet.start(store, SECRET);
      change(store);

      const error = await refusal(() => BrandWallet.start(store, SECRET));

      assert.ok(error instanceof BrandWalletError, what);
    }
  });

  it('without a secret, creates nothing and has no address', async () => {
    const store = new InMemoryBrandWalletStore();

    const wallet = await BrandWallet.start(store, null);

    assert.equal(wallet.address(), null);
    assert.equal(store.row, null);
    assert.equal(store.inserts, 0);
  });

  it('without a secret, leaves a stored wallet as it is and says so in the log', async () => {
    const store = new InMemoryBrandWalletStore();
    const address = (await BrandWallet.start(store, SECRET)).address();
    let wallet: BrandWallet | undefined;

    const lines = await logged(async () => {
      wallet = await BrandWallet.start(store, null);
    });

    assert.equal(wallet?.address(), null, 'a wallet the admin cannot open is not shown');
    assert.equal(store.row?.address, address);
    assert.ok(
      lines.some((line) => line.includes(address!) && line.includes('BRAND_WALLET_SECRET')),
      lines.join('\n'),
    );
  });

  it('refuses a secret that is not 64 hex characters, naming the key and not the value', async () => {
    for (const secret of ['', SECRET.slice(2), `0x${SECRET}`, 'zz'.repeat(32)]) {
      const error = await refusal(() => BrandWallet.start(new InMemoryBrandWalletStore(), secret));

      assert.match(error.message, /BRAND_WALLET_SECRET/, secret);
      if (secret !== '') assert.equal(error.message.includes(secret), false);
    }
  });
});

describe('BrandWallet.signTransaction', () => {
  it("signs an xDAI transfer that reads back as it was asked for, sent from the wallet's address", async () => {
    const wallet = await BrandWallet.start(new InMemoryBrandWalletStore(), SECRET);
    const asked = transfer();

    const signed = await wallet.signTransaction(asked);

    const read = parseTransaction(signed);
    assert.equal(read.type, 'eip1559');
    assert.equal(read.chainId, GNOSIS);
    assert.equal(read.nonce, 7);
    assert.equal(read.to?.toLowerCase(), NODE_WALLET);
    assert.equal(read.value, asked.value);
    assert.equal(read.data, undefined, 'an xDAI transfer carries no call data');
    assert.equal(read.gas, 21_000n);
    assert.equal(read.maxFeePerGas, asked.maxFeePerGas);
    assert.equal(read.maxPriorityFeePerGas, asked.maxPriorityFeePerGas);
    assert.equal(await senderOf(signed), wallet.address());
  });

  it("signs an xBZZ transfer: a call of the token's transfer, with no value", async () => {
    const wallet = await BrandWallet.start(new InMemoryBrandWalletStore(), SECRET);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [NODE_WALLET, 10n ** 16n] });

    const signed = await wallet.signTransaction(transfer({ nonce: 0, to: BZZ_TOKEN, value: 0n, data, gas: 65_000n }));

    const read = parseTransaction(signed);
    assert.equal(read.to?.toLowerCase(), BZZ_TOKEN);
    assert.equal(read.value, undefined, 'an xBZZ transfer sends no xDAI');
    assert.equal(read.data, data);
    assert.equal(read.nonce, 0);
    assert.equal(read.gas, 65_000n);
    assert.equal(await senderOf(signed), wallet.address());
  });

  it('signs a recipient written in mixed case', async () => {
    const wallet = await BrandWallet.start(new InMemoryBrandWalletStore(), SECRET);
    const shouted = `0x${NODE_WALLET.slice(2).toUpperCase()}` as Address;

    const read = parseTransaction(await wallet.signTransaction(transfer({ to: shouted })));

    assert.equal(read.to?.toLowerCase(), NODE_WALLET);
  });

  it('refuses without a wallet', async () => {
    const wallet = await BrandWallet.start(new InMemoryBrandWalletStore(), null);

    const error = await refusal(() => wallet.signTransaction(transfer()));

    assert.ok(error instanceof BrandWalletError);
    assert.match(error.message, /BRAND_WALLET_SECRET/);
  });

  it('refuses what is not a transaction it can sign, and opens no key for it', async () => {
    const store = new InMemoryBrandWalletStore();
    const wallet = await BrandWallet.start(store, SECRET);
    const readsAtStart = store.reads;

    for (const [what, changes] of [
      ['chain id 0', { chainId: 0 }],
      ['a chain id that is no whole number', { chainId: 100.5 }],
      ['a negative nonce', { nonce: -1 }],
      ['a fractional nonce', { nonce: 1.5 }],
      ['a recipient that is no address', { to: '0x1234' as Address }],
      ['call data of half a byte', { data: '0x123' as Hex }],
      ['call data that is not hex', { data: '0xzz' as Hex }],
      ['a negative value', { value: -1n }],
      ['a value given as a number', { value: 1 as unknown as bigint }],
      ['no gas', { gas: 0n }],
      ['a negative fee cap', { maxFeePerGas: -1n }],
      ['a negative tip', { maxPriorityFeePerGas: -1n }],
      ['a tip over the fee cap', { maxPriorityFeePerGas: 3_000_000_000n }],
      ['a value past 256 bits', { value: 2n ** 256n }],
    ] as const) {
      const error = await refusal(() => wallet.signTransaction(transfer(changes)));

      assert.ok(error instanceof BrandWalletError, `${what}: ${error.message}`);
    }
    assert.equal(store.reads, readsAtStart, 'the key was read for a transaction that was refused');
  });

  it('refuses once the stored wallet is gone, or is another than the one it started with', async () => {
    const store = new InMemoryBrandWalletStore();
    const wallet = await BrandWallet.start(store, SECRET);
    const elsewhere = new InMemoryBrandWalletStore();
    await BrandWallet.start(elsewhere, SECRET);

    store.row = elsewhere.row;
    const swapped = await refusal(() => wallet.signTransaction(transfer()));
    store.row = null;
    const gone = await refusal(() => wallet.signTransaction(transfer()));

    assert.ok(swapped instanceof BrandWalletError, swapped.message);
    assert.ok(gone instanceof BrandWalletError, gone.message);
  });
});

describe('the key and the secret', () => {
  it('reach no log line, no error and no view of the wallet object', async () => {
    const store = new InMemoryBrandWalletStore();
    const errors: Error[] = [];
    const keep = async (run: () => Promise<unknown>) => errors.push(await refusal(run));
    let wallet: BrandWallet | undefined;

    const lines = await logged(async () => {
      wallet = await BrandWallet.start(store, SECRET);
      await BrandWallet.start(store, SECRET);
      await wallet.signTransaction(transfer());
      await keep(() => wallet!.signTransaction(transfer({ to: '0x1234' as Address })));
      await keep(() => BrandWallet.start(store, OTHER_SECRET));
      await keep(() => exportBrandWalletKey(store, OTHER_SECRET));
      await BrandWallet.start(store, null);
    });
    const { privateKey } = await exportBrandWalletKey(store, SECRET);

    const secrets = [SECRET, OTHER_SECRET, privateKey];
    assert.equal(holdsAny(lines.join('\n'), secrets), false, 'a log line holds the key or a secret');
    for (const error of errors) {
      assert.equal(holdsAny(`${error.message}\n${error.stack}\n${inspect(error)}`, secrets), false, error.message);
    }
    const views = [JSON.stringify(wallet), inspect(wallet, { showHidden: true, depth: Infinity }), String(wallet)];
    assert.equal(holdsAny(views.join('\n'), secrets), false, 'the wallet object shows the key or the secret');
  });
});

describe('exportBrandWalletKey', () => {
  it('refuses without a secret, without a wallet, and under a secret that does not open it', async () => {
    const empty = new InMemoryBrandWalletStore();
    const store = new InMemoryBrandWalletStore();
    await BrandWallet.start(store, SECRET);

    const noSecret = await refusal(() => exportBrandWalletKey(store, null));
    const noWallet = await refusal(() => exportBrandWalletKey(empty, SECRET));
    const wrongSecret = await refusal(() => exportBrandWalletKey(store, OTHER_SECRET));

    assert.match(noSecret.message, /BRAND_WALLET_SECRET/);
    assert.match(noWallet.message, /no brand wallet/i);
    assert.ok(wrongSecret instanceof BrandWalletError);
  });
});
