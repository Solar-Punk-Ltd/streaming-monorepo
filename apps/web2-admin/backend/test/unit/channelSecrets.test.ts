/**
 * How a notification service's secret is kept: sealed under a key derived from BRAND_WALLET_SECRET, opened only as
 * the service it was sealed for. Unit test. `pnpm test`.
 *
 * What is pinned here: the key of version 1, byte for byte, since a change of it leaves every saved service unreadable;
 * the label a secret is bound to, `notification_channels:<kind>:v1`, under which migration 037 carried the secrets of
 * 035 over; that it is another key than the secret itself; that a sealed secret comes back whole under that key and its
 * own service and under no other; and that nothing a refusal says carries the secret or the key. Every secret here is
 * made up for the test.
 */
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import {
  CHANNEL_SECRET_KEY_VERSION,
  ChannelSecretError,
  channelSecretKeyFrom,
  openChannelSecret,
  sealChannelSecret,
} from '../../src/domain/notifications/channelSecrets.js';

const WALLET_SECRET = 'ab'.repeat(32);
const KEY = channelSecretKeyFrom(WALLET_SECRET);
const TOKEN = `1234567890:${'A'.repeat(35)}`;

/** What version 1 derives from 32 bytes of 0xab: worked out once with HKDF-SHA-256 and pinned. */
const DERIVED_V1 = 'bcda453c259afdd2f7948441c4cc83c8462bb20e1d14f7c77f6e124ef587b5c7';

describe('the key of the channel secrets', () => {
  it('is derived from BRAND_WALLET_SECRET with HKDF-SHA-256 under its own label', () => {
    assert.equal(KEY.toString('hex'), DERIVED_V1);
    assert.deepEqual(channelSecretKeyFrom(WALLET_SECRET), KEY);
    assert.deepEqual(channelSecretKeyFrom(WALLET_SECRET.toUpperCase()), KEY);
  });

  it('is another key than the secret the brand wallet is sealed under', () => {
    assert.equal(KEY.length, 32);
    assert.notDeepEqual(KEY, Buffer.from(WALLET_SECRET, 'hex'));
    assert.notDeepEqual(channelSecretKeyFrom('cd'.repeat(32)), KEY);
  });

  it('is refused from a secret that is not 64 hex characters, in a sentence without it', () => {
    for (const secret of ['', 'ab', `0x${'ab'.repeat(31)}`, 'zz'.repeat(32)]) {
      assert.throws(
        () => channelSecretKeyFrom(secret),
        (error: unknown) =>
          error instanceof ChannelSecretError && (secret.length < 8 || !error.message.includes(secret)),
        JSON.stringify(secret),
      );
    }
  });
});

describe("a channel's secret", () => {
  it('comes back whole under its key and its channel', () => {
    const sealed = sealChannelSecret('telegram', TOKEN, KEY);
    assert.equal(sealed.keyVersion, CHANNEL_SECRET_KEY_VERSION);
    assert.equal(sealed.iv.length, 12);
    assert.equal(sealed.authTag.length, 16);
    assert.equal(sealed.ciphertext.length, TOKEN.length);
    assert.equal(sealed.ciphertext.includes(Buffer.from(TOKEN)), false);
    assert.equal(openChannelSecret('telegram', sealed, KEY), TOKEN);
  });

  it('is sealed with an IV drawn for it', () => {
    const first = sealChannelSecret('telegram', TOKEN, KEY);
    const second = sealChannelSecret('telegram', TOKEN, KEY);
    assert.notDeepEqual(first.iv, second.iv);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
  });

  it('opens under no other key, as no other service, and with no byte changed', () => {
    const sealed = sealChannelSecret('telegram', TOKEN, KEY);
    const flipped = (bytes: Buffer) => {
      const copy = Buffer.from(bytes);
      copy[0] = copy[0]! ^ 1;
      return copy;
    };
    const refusals: (() => string)[] = [
      () => openChannelSecret('telegram', sealed, channelSecretKeyFrom('cd'.repeat(32))),
      () => openChannelSecret('telegram', sealed, randomBytes(16)),
      () => openChannelSecret('email', sealed, KEY),
      () => openChannelSecret('telegram', { ...sealed, ciphertext: flipped(sealed.ciphertext) }, KEY),
      () => openChannelSecret('telegram', { ...sealed, iv: flipped(sealed.iv) }, KEY),
      () => openChannelSecret('telegram', { ...sealed, authTag: flipped(sealed.authTag) }, KEY),
      () => openChannelSecret('telegram', { ...sealed, keyVersion: CHANNEL_SECRET_KEY_VERSION + 1 }, KEY),
    ];
    for (const [index, refusal] of refusals.entries()) {
      assert.throws(
        refusal,
        (error: unknown) => {
          assert.ok(error instanceof ChannelSecretError, `refusal ${index}`);
          const shown = `${error.message} ${inspect(error)}`;
          assert.equal(shown.includes(TOKEN), false);
          assert.equal(shown.includes(KEY.toString('hex')), false);
          assert.equal(shown.includes(WALLET_SECRET), false);
          return true;
        },
        `refusal ${index}`,
      );
    }
  });

  it('opens a secret sealed under the label of migration 035, as 037 carried it over', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('notification_channels:telegram:v1', 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(TOKEN, 'utf8'), cipher.final()]);
    const carried = { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: 1 };
    assert.equal(openChannelSecret('telegram', carried, KEY), TOKEN);
  });

  it('is sealed only when there is one, under a key of 32 bytes', () => {
    assert.throws(() => sealChannelSecret('email', '', KEY), ChannelSecretError);
    assert.throws(() => sealChannelSecret('email', 'secret', randomBytes(16)), ChannelSecretError);
  });
});
