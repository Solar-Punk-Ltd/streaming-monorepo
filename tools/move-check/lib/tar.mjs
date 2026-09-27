import { createHash } from 'node:crypto';

const BLOCK_SIZE = 512;

/** Where each field sits in a 512-byte header, as `[offset, length]`. */
const FIELD = Object.freeze({
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  checksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  prefix: [345, 155],
});

/** The magic of the POSIX ustar layout. The old GNU layout writes "ustar " and puts other data where the prefix goes. */
const POSIX_USTAR_MAGIC = 'ustar\0';

/** Permission bits with setuid, setgid and sticky. Some writers also store file-type bits in the mode field. */
const PERMISSION_BITS = 0o7777;

/** Pax headers and GNU long names are small. A larger one means the stream is misread or hostile. */
const MAX_METADATA_BYTES = 1024 * 1024;

const ENTRY_TYPE_BY_FLAG = new Map([
  ['0', 'file'],
  ['\0', 'file'],
  ['7', 'file'],
  ['1', 'hardlink'],
  ['2', 'symlink'],
  ['3', 'char-device'],
  ['4', 'block-device'],
  ['5', 'directory'],
  ['6', 'fifo'],
]);

const METADATA_FLAG = Object.freeze({ paxNext: 'x', paxGlobal: 'g', gnuLongName: 'L', gnuLongLink: 'K' });

/** A tar stream that cannot be read to its end. */
export class TarFormatError extends Error {}

/**
 * @typedef {object} TarEntrySummary
 * @property {string} path relative, with no leading ./ and no trailing slash
 * @property {'file'|'hardlink'|'symlink'|'char-device'|'block-device'|'directory'|'fifo'} type
 * @property {number} mode permission bits, setuid, setgid and sticky included
 * @property {number} uid
 * @property {number} gid
 * @property {number} size bytes of content, 0 for anything but a regular file
 * @property {string} [linkTarget] for a symlink its target, for a hard link the path it names
 * @property {string} [sha256] for a regular file, the hex digest of its content
 */

/** Hands out exact byte counts from a stream of chunks of any size. */
class ChunkReader {
  #chunks;
  #current = Buffer.alloc(0);
  #offset = 0;
  #ended = false;

  constructor(chunks) {
    const iterate = chunks[Symbol.asyncIterator] ?? chunks[Symbol.iterator];
    this.#chunks = iterate.call(chunks);
  }

  async #fill() {
    while (this.#offset >= this.#current.length && !this.#ended) {
      const { value, done } = await this.#chunks.next();
      if (done) {
        this.#ended = true;
      } else {
        this.#current = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.#offset = 0;
      }
    }
  }

  /** Passes up to `size` bytes to `consume`, slice by slice, and returns how many arrived. */
  async forEachSlice(size, consume) {
    let remaining = size;
    while (remaining > 0) {
      await this.#fill();
      if (this.#offset >= this.#current.length) break;
      const take = Math.min(remaining, this.#current.length - this.#offset);
      consume(this.#current.subarray(this.#offset, this.#offset + take));
      this.#offset += take;
      remaining -= take;
    }
    return size - remaining;
  }

  /** Reads up to `size` bytes. Fewer come back only when the stream has ended. */
  async read(size) {
    const parts = [];
    await this.forEachSlice(size, (slice) => parts.push(slice));
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** Reads and discards whatever is left, so the writer of the stream is never left blocked. */
  async drain() {
    while (!this.#ended) {
      this.#offset = this.#current.length;
      await this.#fill();
    }
  }
}

function field(block, name) {
  const [offset, length] = FIELD[name];
  return block.subarray(offset, offset + length);
}

function readText(bytes) {
  const end = bytes.indexOf(0);
  return bytes.toString('utf8', 0, end === -1 ? bytes.length : end);
}

/** Reads a number field: octal digits padded with NUL or space, or, with the top bit set, base-256. */
function readNumber(block, name) {
  const bytes = field(block, name);
  if (bytes[0] & 0x80) return readBase256(bytes, name);
  const digits = bytes.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) throw new TarFormatError(`The ${name} field holds ${JSON.stringify(digits)}, which is not an octal number.`);
  return Number.parseInt(digits, 8);
}

function readBase256(bytes, name) {
  if (bytes[0] & 0x40) throw new TarFormatError(`The ${name} field holds a negative base-256 number.`);
  const value = [...bytes.subarray(1)].reduce((total, byte) => (total << 8n) | BigInt(byte), BigInt(bytes[0] & 0x3f));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TarFormatError(`The ${name} field holds a number too large to read.`);
  return Number(value);
}

/** Old writers summed the header as signed bytes, so either sum is accepted. */
function verifyChecksum(block) {
  const [offset, length] = FIELD.checksum;
  const bytes = [...block].map((byte, index) => (index >= offset && index < offset + length ? 0x20 : byte));
  const unsigned = bytes.reduce((sum, byte) => sum + byte, 0);
  const signed = bytes.reduce((sum, byte) => sum + (byte > 127 ? byte - 256 : byte), 0);
  const stored = readNumber(block, 'checksum');
  if (stored !== unsigned && stored !== signed) {
    const name = readText(field(block, 'name'));
    throw new TarFormatError(`The header of ${JSON.stringify(name)} fails its checksum, so the stream is damaged or was misread.`);
  }
}

function parseHeader(block) {
  verifyChecksum(block);
  const name = readText(field(block, 'name'));
  const isPosixUstar = field(block, 'magic').toString('latin1') === POSIX_USTAR_MAGIC;
  const prefix = isPosixUstar ? readText(field(block, 'prefix')) : '';
  return {
    name: prefix === '' ? name : `${prefix}/${name}`,
    mode: readNumber(block, 'mode'),
    uid: readNumber(block, 'uid'),
    gid: readNumber(block, 'gid'),
    size: readNumber(block, 'size'),
    typeflag: String.fromCharCode(block[FIELD.typeflag[0]]),
    linkname: readText(field(block, 'linkname')),
  };
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function paddingAfter(size) {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

/** Feeds an entry's data to `consume` and skips the padding after it. */
async function consumeData(input, size, label, consume) {
  const received = await input.forEachSlice(size, consume);
  const padding = paddingAfter(size);
  const skipped = await input.forEachSlice(padding, () => {});
  if (received < size || skipped < padding) throw new TarFormatError(`The archive ends inside the data of ${JSON.stringify(label)}.`);
}

async function readMetadata(input, size, label) {
  if (size > MAX_METADATA_BYTES) throw new TarFormatError(`The ${label} member claims ${size} bytes, far more than such a member holds.`);
  const parts = [];
  await consumeData(input, size, label, (slice) => parts.push(slice));
  return Buffer.concat(parts);
}

async function hashData(input, size, label) {
  const hash = createHash('sha256');
  await consumeData(input, size, label, (slice) => hash.update(slice));
  return hash.digest('hex');
}

function parseDecimal(text, key) {
  if (!/^\d+$/.test(text)) throw new TarFormatError(`The pax record ${key} holds ${JSON.stringify(text)}, which is not a whole number.`);
  return Number(text);
}

/** Reads pax records, each `<length> <key>=<value>\n` where the length counts the whole record in bytes. */
function parsePaxRecords(data) {
  const records = [];
  for (let position = 0; position < data.length; ) {
    const space = data.indexOf(0x20, position);
    const length = space === -1 ? Number.NaN : Number(data.toString('latin1', position, space));
    const end = position + length;
    if (!Number.isInteger(length) || length <= 0 || end > data.length || data[end - 1] !== 0x0a) {
      throw new TarFormatError('A pax extended header is malformed.');
    }
    const record = data.toString('utf8', space + 1, end - 1);
    const equals = record.indexOf('=');
    if (equals === -1) throw new TarFormatError(`A pax record has no equals sign: ${JSON.stringify(record)}.`);
    records.push([record.slice(0, equals), record.slice(equals + 1)]);
    position = end;
  }
  return Object.fromEntries(records);
}

/** The parts of a pax header that change the summary of the next entry. */
function paxOverrides(records) {
  return {
    ...(records.path !== undefined && { path: records.path }),
    ...(records.linkpath !== undefined && { linkpath: records.linkpath }),
    ...(records.size !== undefined && { size: parseDecimal(records.size, 'size') }),
    ...(records.uid !== undefined && { uid: parseDecimal(records.uid, 'uid') }),
    ...(records.gid !== undefined && { gid: parseDecimal(records.gid, 'gid') }),
  };
}

function normalizeEntryPath(name) {
  const trimmed = name.replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
}

function entryType(typeflag, rawName) {
  const type = ENTRY_TYPE_BY_FLAG.get(typeflag);
  if (type === undefined) {
    throw new TarFormatError(`${JSON.stringify(rawName)} has the tar type ${JSON.stringify(typeflag)}, which this reader does not handle.`);
  }
  return type === 'file' && rawName.endsWith('/') ? 'directory' : type;
}

async function summarizeEntry(input, header, overrides) {
  const rawName = overrides.path ?? header.name;
  const type = entryType(header.typeflag, rawName);
  const size = overrides.size ?? header.size;
  const summary = {
    path: normalizeEntryPath(rawName),
    type,
    mode: header.mode & PERMISSION_BITS,
    uid: overrides.uid ?? header.uid,
    gid: overrides.gid ?? header.gid,
    size: type === 'file' ? size : 0,
  };
  if (type === 'file') return { ...summary, sha256: await hashData(input, size, rawName) };
  await consumeData(input, size, rawName, () => {});
  const target = overrides.linkpath ?? header.linkname;
  if (type === 'symlink') return { ...summary, linkTarget: target };
  if (type === 'hardlink') return { ...summary, linkTarget: normalizeEntryPath(target) };
  return summary;
}

/**
 * Reads a tar stream and summarizes every entry: path, type, permission bits, owner, size, a link's target
 * and a regular file's sha256. Modification times are ignored. Handles the ustar prefix field, pax headers
 * and GNU long names, and reads the stream to its end.
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks the stream, in chunks of any size
 * @returns {Promise<TarEntrySummary[]>}
 */
export async function readTarSummaries(chunks) {
  const input = new ChunkReader(chunks);
  const summaries = [];
  let overrides = {};
  for (;;) {
    const block = await input.read(BLOCK_SIZE);
    if (block.length === 0) throw new TarFormatError('The archive ends without its end-of-archive marker.');
    if (block.length < BLOCK_SIZE) throw new TarFormatError('The archive ends inside a header.');
    if (isZeroBlock(block)) {
      await input.drain();
      return summaries;
    }
    const header = parseHeader(block);
    switch (header.typeflag) {
      case METADATA_FLAG.paxNext:
        overrides = { ...overrides, ...paxOverrides(parsePaxRecords(await readMetadata(input, header.size, 'pax header'))) };
        break;
      case METADATA_FLAG.paxGlobal:
        await readMetadata(input, header.size, 'pax global header');
        break;
      case METADATA_FLAG.gnuLongName:
        overrides = { ...overrides, path: readText(await readMetadata(input, header.size, 'GNU long name')) };
        break;
      case METADATA_FLAG.gnuLongLink:
        overrides = { ...overrides, linkpath: readText(await readMetadata(input, header.size, 'GNU long link')) };
        break;
      default:
        summaries.push(await summarizeEntry(input, header, overrides));
        overrides = {};
    }
  }
}
