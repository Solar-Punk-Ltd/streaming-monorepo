const BLOCK_SIZE = 512;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;

function writeOctal(header, value, offset, length) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'latin1');
}

/** Recomputes a header's checksum after a test has edited its bytes by hand. */
export function rewriteChecksum(header) {
  header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, CHECKSUM_OFFSET, CHECKSUM_LENGTH, 'latin1');
  return header;
}

/**
 * Builds one 512-byte tar header in the POSIX ustar layout, or in the old GNU layout with `gnu: true`.
 * `type` is the one-character type flag.
 */
export function tarHeader({ name, mode = 0o644, uid = 0, gid = 0, size = 0, type = '0', linkname = '', prefix = '', gnu = false }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, mode, 100, 8);
  writeOctal(header, uid, 108, 8);
  writeOctal(header, gid, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.write(type, 156, 1, 'latin1');
  header.write(linkname, 157, 100, 'utf8');
  header.write(gnu ? 'ustar  \0' : 'ustar\u000000', 257, 8, 'latin1');
  header.write(prefix, 345, 155, 'utf8');
  return rewriteChecksum(header);
}

function padToBlocks(data) {
  const remainder = data.length % BLOCK_SIZE;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK_SIZE - remainder)]);
}

/** One archive member: its header, then its data padded to whole blocks. */
export function tarEntry(fields, data = '') {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return Buffer.concat([tarHeader({ ...fields, size: fields.size ?? bytes.length }), padToBlocks(bytes)]);
}

/** One pax record. Its leading length counts every byte of the record, the length's own digits included. */
function paxRecord(key, value) {
  const content = ` ${key}=${value}\n`;
  const contentLength = Buffer.byteLength(content);
  let length = contentLength;
  while (String(length).length + contentLength !== length) length = String(length).length + contentLength;
  return `${length}${content}`;
}

/** A pax extended header, type `x` for the entry after it or `g` for every entry. */
export function paxEntry(records, type = 'x') {
  const body = Object.entries(records)
    .map(([key, value]) => paxRecord(key, value))
    .join('');
  return tarEntry({ name: 'PaxHeaders/entry', type }, body);
}

/** A GNU member that gives the next entry a long name (`L`) or a long link target (`K`). */
export function gnuLongName(name, type = 'L') {
  return tarEntry({ name: '././@LongLink', type, gnu: true }, `${name}\0`);
}

/** The two zero blocks that end an archive. */
export const END_OF_ARCHIVE = Buffer.alloc(BLOCK_SIZE * 2);

/** A whole archive: the members, then the end-of-archive marker. */
export function tarArchive(...members) {
  return Buffer.concat([...members, END_OF_ARCHIVE]);
}
