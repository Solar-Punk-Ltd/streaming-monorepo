import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with node:crypto scrypt — no dependency, and the stored
 * string carries its own cost parameters:
 *
 *   scrypt$N$r$p$saltBase64$hashBase64
 *
 * so the cost can be raised later without invalidating existing hashes: a hash
 * is always verified with the parameters it was written with.
 */
const ALGORITHM = 'scrypt';
const COST = 16_384; // N: 128 * N * r = 16 MiB of memory per hash, under node's 32 MiB default maxmem
const BLOCK_SIZE = 8; // r
const PARALLELISATION = 1; // p
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: number,
  blockSize: number,
  parallelisation: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelisation },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(
    password,
    salt,
    KEY_LENGTH,
    COST,
    BLOCK_SIZE,
    PARALLELISATION,
  );
  return [
    ALGORITHM,
    COST,
    BLOCK_SIZE,
    PARALLELISATION,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Constant-time comparison against a stored hash. Throws on a stored string
 * that is not a scrypt hash at all: that is corrupt data, not a wrong
 * password, and it should not read as an authentication failure.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    throw new Error('Stored password hash is not in scrypt$N$r$p$salt$hash form');
  }
  const [, costRaw, blockSizeRaw, parallelisationRaw, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelisation = Number(parallelisationRaw);
  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelisation)
  ) {
    throw new Error('Stored password hash has non-integer scrypt parameters');
  }

  const expected = Buffer.from(hashB64, 'base64');
  const actual = await deriveKey(
    password,
    Buffer.from(saltB64, 'base64'),
    expected.length,
    cost,
    blockSize,
    parallelisation,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
