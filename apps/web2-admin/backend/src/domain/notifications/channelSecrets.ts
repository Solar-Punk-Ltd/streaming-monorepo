import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { NOTICE_SERVICE_NAMES, type NoticeServiceKind } from '@streaming-monorepo/web2-admin-common';

import { BRAND_WALLET_SECRET_KEY, brandWalletSecretProblem } from '../../utils/fundingSettings.js';

import type { SealedSecret } from './NoticeStore.js';

/**
 * How a notification service's secret is kept (docs/architecture/notifications.md): the email service's API key and
 * the Telegram bot's token. Each is encrypted with AES-256-GCM, as the brand wallet's key is, and stored in
 * `notification_services` (migration 037) with the version of the key it is under.
 *
 * The key of version 1 is derived from `BRAND_WALLET_SECRET` with HKDF-SHA-256 under a label of its own, so it is a
 * different key from the one the brand wallet's key is encrypted under, and neither is in the database. The service's
 * kind and the key's version are bound into the encryption, so a row's secret opens only as that service's. The
 * binding keeps the words of migration 035, `notification_channels:<kind>:v1`, under which the secrets 037 carried
 * over were sealed, so they open as before.
 *
 * A secret is opened for the one send, test or lookup that needs it. Nothing here logs or answers a secret or a key.
 */

/** The version of the key a secret is sealed under now. */
export const CHANNEL_SECRET_KEY_VERSION = 1;

/** HKDF's label for the key of version 1. A change of it is a new version. */
const KEY_V1_INFO = 'web2-admin/notification-channel-secrets/v1';

/** AES-256-GCM, with the IV and tag lengths NIST SP 800-38D recommends. */
const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Why a service's secret could not be sealed or opened, in a sentence. Never carries a secret or a key. */
export class ChannelSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelSecretError';
  }
}

/** The key of version 1, from `BRAND_WALLET_SECRET`'s 64 hex characters. */
export function channelSecretKeyFrom(brandWalletSecret: string): Buffer {
  const problem = brandWalletSecretProblem(brandWalletSecret);
  if (problem) throw new ChannelSecretError(problem);
  const secret = Buffer.from(brandWalletSecret, 'hex');
  try {
    return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_V1_INFO, KEY_BYTES));
  } finally {
    secret.fill(0);
  }
}

/** What binds a sealed secret to its service and its key's version: migration 035's words, which 037 kept. */
function boundTo(kind: NoticeServiceKind, keyVersion: number): Buffer {
  return Buffer.from(`notification_channels:${kind}:v${keyVersion}`, 'utf8');
}

/** The service's secret encrypted under the key, with an IV drawn for it. */
export function sealChannelSecret(kind: NoticeServiceKind, secret: string, key: Buffer): SealedSecret {
  if (key.length !== KEY_BYTES) throw new ChannelSecretError('The key of the service secrets is 32 bytes.');
  if (secret === '') throw new ChannelSecretError('A service has a secret.');
  const plain = Buffer.from(secret, 'utf8');
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(boundTo(kind, CHANNEL_SECRET_KEY_VERSION));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CHANNEL_SECRET_KEY_VERSION };
  } finally {
    plain.fill(0);
  }
}

/**
 * The service's secret, decrypted. A key that fails GCM's tag, a changed byte, another service's row and a version
 * this code has no key for are refused alike, in a sentence that carries neither the secret nor the key.
 */
export function openChannelSecret(kind: NoticeServiceKind, sealed: SealedSecret, key: Buffer): string {
  const refused = () =>
    new ChannelSecretError(
      `The ${NOTICE_SERVICE_NAMES[kind]} service's secret does not open with this ${BRAND_WALLET_SECRET_KEY}: it was saved under another secret, or its row was changed. Save the service again with its secret.`,
    );
  if (sealed.keyVersion !== CHANNEL_SECRET_KEY_VERSION || key.length !== KEY_BYTES) throw refused();
  let plain: Buffer;
  try {
    const decipher = createDecipheriv(CIPHER, key, sealed.iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(boundTo(kind, sealed.keyVersion));
    decipher.setAuthTag(sealed.authTag);
    plain = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    throw refused();
  }
  try {
    return plain.toString('utf8');
  } finally {
    plain.fill(0);
  }
}
