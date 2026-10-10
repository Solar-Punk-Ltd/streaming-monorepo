/**
 * The brand wallet's row in memory, with the semantics of `BrandWalletRepository` that matter: one row at most, and
 * an insert that finds one stored already keeps it and answers it. Each read answers a copy, so a test that changes
 * `row` changes what the next read finds, as an UPDATE outside the admin would, and nothing the wallet holds.
 */
import type {
  BrandWalletRow,
  BrandWalletStore,
  NewBrandWalletRow,
} from '../../../src/domain/funding/BrandWalletRepository.js';

function copyOf<T extends NewBrandWalletRow>(row: T): T {
  return {
    ...row,
    keyCiphertext: Buffer.from(row.keyCiphertext),
    keyIv: Buffer.from(row.keyIv),
    keyAuthTag: Buffer.from(row.keyAuthTag),
  };
}

export class InMemoryBrandWalletStore implements BrandWalletStore {
  /** The stored row, or null before the first start with a secret. */
  row: BrandWalletRow | null = null;
  /** How many reads were asked for: each one is a decryption the wallet could make. */
  reads = 0;
  /** How many inserts were asked for, whether they stored a row or found one. */
  inserts = 0;

  async find(): Promise<BrandWalletRow | null> {
    this.reads += 1;
    return this.row ? copyOf(this.row) : null;
  }

  async insertIfNone(row: NewBrandWalletRow): Promise<BrandWalletRow> {
    this.inserts += 1;
    this.row ??= { ...copyOf(row), createdAt: new Date() };
    return copyOf(this.row);
  }
}
