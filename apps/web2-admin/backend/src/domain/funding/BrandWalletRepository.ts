import type { Pool } from 'pg';
import type { Address } from 'viem';

/** The row of `brand_wallet`, migration 015: the wallet's address and its private key, encrypted. */
export interface BrandWalletRow {
  /** 0x and 40 hex digits, lower case. */
  address: Address;
  /** The key's 32 bytes, encrypted with AES-256-GCM under BRAND_WALLET_SECRET. */
  keyCiphertext: Buffer;
  /** The 12 random bytes the encryption used. */
  keyIv: Buffer;
  /** GCM's 16-byte tag. */
  keyAuthTag: Buffer;
  createdAt: Date;
}

/** A wallet as the brand wallet stores it, before the database stamps it. */
export type NewBrandWalletRow = Omit<BrandWalletRow, 'createdAt'>;

/** Where the brand wallet is kept: Postgres, or memory in the unit tests. */
export interface BrandWalletStore {
  /** The wallet, or null before the first start with a secret. */
  find(): Promise<BrandWalletRow | null>;
  /**
   * Stores `row` unless a wallet is stored already, and answers the stored wallet's row, which is another one when a
   * start running beside this one stored its own first.
   */
  insertIfNone(row: NewBrandWalletRow): Promise<BrandWalletRow>;
}

const COLUMNS = `address, key_ciphertext AS "keyCiphertext", key_iv AS "keyIv", key_auth_tag AS "keyAuthTag",
  created_at AS "createdAt"`;

/** The brand wallet's one row, migration 015. */
export class BrandWalletRepository implements BrandWalletStore {
  constructor(private readonly pool: Pool) {}

  async find(): Promise<BrandWalletRow | null> {
    const result = await this.pool.query<BrandWalletRow>(`SELECT ${COLUMNS} FROM brand_wallet`);
    return result.rows[0] ?? null;
  }

  async insertIfNone(row: NewBrandWalletRow): Promise<BrandWalletRow> {
    // The singleton key holds one wallet: a second start racing this one keeps the first wallet stored, and both
    // answer it. The read is a statement of its own, so it sees a row another start committed.
    await this.pool.query(
      `INSERT INTO brand_wallet (id, address, key_ciphertext, key_iv, key_auth_tag)
       VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [row.address, row.keyCiphertext, row.keyIv, row.keyAuthTag],
    );
    const stored = await this.find();
    if (!stored) throw new Error('The brand wallet was stored, and then not found.');
    return stored;
  }
}
