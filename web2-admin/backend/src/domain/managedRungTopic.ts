import { createHash } from 'node:crypto';

const RUNG_TOPIC_NAMESPACE = '6f9e1b2c-7d04-4a18-9f3e-2c5b8a6d4e10';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The uploader's stable RFC 4122 version-5 rung topic contract. */
export function managedRungTopicFor(group: string, rung: string): string {
  const bytes = createHash('sha1')
    .update(uuidBytes(RUNG_TOPIC_NAMESPACE))
    .update(Buffer.from(`${group}/${rung}`, 'utf8'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}
