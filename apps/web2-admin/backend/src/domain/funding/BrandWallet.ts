import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';

import { BRAND_WALLET_SECRET_KEY, brandWalletSecretProblem } from '../../utils/fundingSettings.js';
import { Logger } from '../Logger.js';
import type { BrandWalletRow, BrandWalletStore } from './BrandWalletRepository.js';

/**
 * The brand wallet (docs/architecture/funding.md): the wallet the admin sends xDAI and xBZZ from to the wallets of the
 * brand's nodes. The admin signs each transfer and the manager sends it, so the key never leaves the admin.
 *
 * The key is created on the first start with `BRAND_WALLET_SECRET` set, and stored in `brand_wallet` (migration 015)
 * encrypted with AES-256-GCM under that secret. Every start decrypts it once, so a secret that does not open it stops
 * the start, and keeps the address alone. `signTransaction` decrypts it again for the one signature and drops it when
 * it returns: nothing holds the key between calls, and nothing logs or answers it or the secret. `wallet:export`
 * prints it once, for the backup handed to the brand.
 */

const logger = Logger.getInstance();

/** AES-256-GCM, with the IV and tag lengths NIST SP 800-38D recommends. */
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** A secp256k1 private key's length. */
const KEY_BYTES = 32;

/** The most a transaction's value, gas or fees can be. */
const MAX_UINT256 = 2n ** 256n - 1n;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** `0x` and whole bytes in hex, none at all included. */
const CALL_DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * One EIP-1559 transaction for the brand wallet to sign. The funding service builds it from the manager's account
 * answer (the pending nonce, the fees and the suggested gas limits) and the transfer an operator asked for. Amounts
 * are bigints of base units, never floats.
 */
export interface BrandWalletTransaction {
  /** The chain the transaction is valid on, fixed in the admin: Gnosis Chain is 100. */
  chainId: number;
  /** The wallet's next nonce: the pending one the manager answered, plus one for each transfer signed since. */
  nonce: number;
  /** For xDAI the node's wallet, for xBZZ the BZZ token's contract. Any case. */
  to: Address;
  /** Wei sent: the amount for xDAI, 0 for xBZZ. */
  value: bigint;
  /** `0x` for xDAI; for xBZZ the token's `transfer(node wallet, amount in PLUR)`. */
  data: Hex;
  /** The gas limit. */
  gas: bigint;
  /** The most wei per gas the transaction pays, base fee and tip together. */
  maxFeePerGas: bigint;
  /** The most wei per gas of that which goes to the block's producer. */
  maxPriorityFeePerGas: bigint;
}

/** Why the brand wallet could not be opened, created or used, in a sentence. Never carries the key or the secret. */
export class BrandWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandWalletError';
  }
}

/** The secret's 32 bytes, from its 64 hex characters. */
function secretBytes(secret: string): Buffer {
  const problem = brandWalletSecretProblem(secret);
  if (problem) throw new BrandWalletError(problem);
  return Buffer.from(secret, 'hex');
}

/** The key encrypted under the secret, with an IV drawn for it. */
function sealKey(privateKey: Hex, secret: Buffer): Pick<BrandWalletRow, 'keyCiphertext' | 'keyIv' | 'keyAuthTag'> {
  const plain = Buffer.from(privateKey.slice(2), 'hex');
  try {
    const keyIv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, secret, keyIv, { authTagLength: AUTH_TAG_BYTES });
    const keyCiphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { keyCiphertext, keyIv, keyAuthTag: cipher.getAuthTag() };
  } finally {
    plain.fill(0);
  }
}

/**
 * The stored wallet's key, decrypted, once it is known to be the key of the stored address. A secret that fails GCM's
 * tag, a changed byte and a key of another address are refused alike, in a sentence that carries neither the key nor
 * the secret. The bytes are zeroed once the key is text; the text itself, which viem takes, cannot be.
 */
function openKey(row: BrandWalletRow, secret: Buffer): Hex {
  const refused = () =>
    new BrandWalletError(
      `The brand wallet ${row.address} does not open with this ${BRAND_WALLET_SECRET_KEY}: it was created under another secret, or its row was changed. Set the secret it was created with.`,
    );
  let plain: Buffer;
  try {
    const decipher = createDecipheriv(CIPHER, secret, row.keyIv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(row.keyAuthTag);
    plain = Buffer.concat([decipher.update(row.keyCiphertext), decipher.final()]);
  } catch {
    throw refused();
  }
  try {
    if (plain.length !== KEY_BYTES) throw refused();
    const privateKey: Hex = `0x${plain.toString('hex')}`;
    let address: string;
    try {
      address = privateKeyToAddress(privateKey).toLowerCase();
    } catch {
      throw refused();
    }
    if (address !== row.address) throw refused();
    return privateKey;
  } finally {
    plain.fill(0);
  }
}

/** A new wallet, stored unless a start beside this one stored its own first. Answers the stored one either way. */
async function createWallet(store: BrandWalletStore, secret: Buffer): Promise<BrandWalletRow> {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAddress(privateKey).toLowerCase() as Address;
  const stored = await store.insertIfNone({ address, ...sealKey(privateKey, secret) });
  if (stored.address === address) {
    logger.info(
      `[Funding] created the brand wallet ${address}. Its key is in the database, encrypted under ${BRAND_WALLET_SECRET_KEY}; back it up for the brand with wallet:export.`,
    );
  }
  return stored;
}

function isUint256(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256;
}

/** Why the brand wallet will not sign this, in a sentence, or null. */
function transactionProblem(transaction: BrandWalletTransaction): string | null {
  const { chainId, nonce, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } = transaction;
  if (!Number.isSafeInteger(chainId) || chainId < 1) return 'The chain id must be a whole number above 0.';
  if (!Number.isSafeInteger(nonce) || nonce < 0) return 'The nonce must be a whole number, 0 or more.';
  if (typeof to !== 'string' || !ADDRESS_PATTERN.test(to)) {
    return 'The recipient must be an address, 0x and 40 hex digits.';
  }
  if (typeof data !== 'string' || !CALL_DATA_PATTERN.test(data)) {
    return 'The call data must be 0x and whole bytes in hex.';
  }
  if (!isUint256(value)) return 'The value must be a bigint of wei, 0 or more, within 256 bits.';
  if (!isUint256(gas) || gas === 0n) return 'The gas limit must be a bigint above 0, within 256 bits.';
  if (!isUint256(maxFeePerGas) || !isUint256(maxPriorityFeePerGas)) {
    return 'The fees must be bigints of wei per gas, 0 or more, within 256 bits.';
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    return 'The tip, maxPriorityFeePerGas, cannot be over the fee cap, maxFeePerGas.';
  }
  return null;
}

/**
 * The brand wallet as one start of the API found it: the address alone, and what it takes to open the key for a
 * signature. `address()` and `signTransaction()` are what the funding service uses of it.
 */
export class BrandWallet {
  // The language's private fields rather than TypeScript's, so neither JSON.stringify nor util.inspect, and so no log
  // line that prints the object, shows the secret.
  readonly #store: BrandWalletStore;
  readonly #secret: Buffer | null;
  readonly #address: Address | null;

  private constructor(store: BrandWalletStore, secret: Buffer | null, address: Address | null) {
    this.#store = store;
    this.#secret = secret;
    this.#address = address;
  }

  /**
   * The brand wallet for this start. Without a secret there is none: nothing is created, and a stored wallet is left
   * as it is and named in the log. With one, the stored wallet is decrypted once, and a secret that does not open it
   * stops the start; where none is stored, one is created, its key encrypted under the secret.
   */
  static async start(store: BrandWalletStore, secret: string | null): Promise<BrandWallet> {
    if (secret === null) {
      const stored = await store.find();
      if (stored) {
        logger.warn(
          `[Funding] the brand wallet ${stored.address} is in the database, but ${BRAND_WALLET_SECRET_KEY} is unset, so it is not shown and signs nothing. Set the secret it was created with.`,
        );
      }
      return new BrandWallet(store, null, null);
    }
    const key = secretBytes(secret);
    const row = (await store.find()) ?? (await createWallet(store, key));
    // Decrypted to check the secret opens it, and dropped: the address is all a start keeps.
    openKey(row, key);
    return new BrandWallet(store, key, row.address);
  }

  /** The wallet's address, 0x and 40 hex digits in lower case, or null while `BRAND_WALLET_SECRET` is unset. */
  address(): Address | null {
    return this.#address;
  }

  /**
   * `transaction` signed with the wallet's key and serialized as `eth_sendRawTransaction` takes it: `0x02` and the
   * EIP-1559 transaction's RLP. The key is decrypted inside the call and dropped when it returns. Refused without a
   * wallet, for a transaction that is not one before any key is read, and once the stored wallet is gone or is another
   * than the one this start opened.
   */
  async signTransaction(transaction: BrandWalletTransaction): Promise<Hex> {
    if (this.#secret === null || this.#address === null) {
      throw new BrandWalletError(`There is no brand wallet to sign with: ${BRAND_WALLET_SECRET_KEY} is unset.`);
    }
    const problem = transactionProblem(transaction);
    if (problem) throw new BrandWalletError(problem);
    const row = await this.#store.find();
    if (!row) {
      throw new BrandWalletError(`The brand wallet ${this.#address} is gone from the database, so nothing is signed.`);
    }
    if (row.address !== this.#address) {
      throw new BrandWalletError(
        `The brand wallet in the database is not ${this.#address}, the one this start opened, so nothing is signed.`,
      );
    }
    const account = privateKeyToAccount(openKey(row, this.#secret));
    // Field by field, so nothing but these reaches the signature, whatever else the object carries.
    return account.signTransaction({
      type: 'eip1559',
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      to: transaction.to.toLowerCase() as Address,
      value: transaction.value,
      data: transaction.data,
      gas: transaction.gas,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    });
  }
}

/**
 * The brand wallet's address and private key, decrypted, for `wallet:export` alone, which prints the key once for the
 * backup handed to the brand. Nothing in the API calls it. Refused without a secret, without a wallet, and under a
 * secret that does not open the stored one.
 */
export async function exportBrandWalletKey(
  store: BrandWalletStore,
  secret: string | null,
): Promise<{ address: Address; privateKey: Hex }> {
  if (secret === null) {
    throw new BrandWalletError(
      `${BRAND_WALLET_SECRET_KEY} is unset, so the brand wallet cannot be opened. Set the secret it was created with.`,
    );
  }
  const key = secretBytes(secret);
  const row = await store.find();
  if (!row) {
    throw new BrandWalletError(
      `There is no brand wallet yet. The API creates it on its first start with ${BRAND_WALLET_SECRET_KEY} set.`,
    );
  }
  return { address: row.address, privateKey: openKey(row, key) };
}
