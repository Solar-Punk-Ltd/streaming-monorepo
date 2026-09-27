import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { TarFormatError, readTarSummaries } from '../lib/tar.mjs';
import { END_OF_ARCHIVE, gnuLongName, paxEntry, rewriteChecksum, tarArchive, tarEntry, tarHeader } from './support/tar-builder.mjs';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function inChunksOf(size, buffer) {
  return Array.from({ length: Math.ceil(buffer.length / size) }, (_, index) => buffer.subarray(index * size, (index + 1) * size));
}

function file(path, content, extra = {}) {
  return { path, type: 'file', mode: 0o644, uid: 0, gid: 0, size: Buffer.byteLength(content), sha256: sha256(content), ...extra };
}

describe('readTarSummaries', () => {
  it('summarizes a regular file by path, mode, owner, size and sha256', async () => {
    const archive = tarArchive(tarEntry({ name: 'app/index.js', uid: 1000, gid: 1001 }, 'console.log(1)\n'));
    assert.deepEqual(await readTarSummaries([archive]), [file('app/index.js', 'console.log(1)\n', { uid: 1000, gid: 1001 })]);
  });

  it('summarizes an empty regular file', async () => {
    assert.deepEqual(await readTarSummaries([tarArchive(tarEntry({ name: '.dockerenv' }))]), [file('.dockerenv', '')]);
  });

  it('reads a directory, a symlink with its target and a hard link with the path it names', async () => {
    const archive = tarArchive(
      tarEntry({ name: './etc/', type: '5', mode: 0o755 }),
      tarEntry({ name: 'etc/alias', type: '2', linkname: '../usr/share/alias', mode: 0o777 }),
      tarEntry({ name: 'usr/bin/perl5', type: '1', linkname: './usr/bin/perl' }),
    );
    assert.deepEqual(await readTarSummaries([archive]), [
      { path: 'etc', type: 'directory', mode: 0o755, uid: 0, gid: 0, size: 0 },
      { path: 'etc/alias', type: 'symlink', mode: 0o777, uid: 0, gid: 0, size: 0, linkTarget: '../usr/share/alias' },
      { path: 'usr/bin/perl5', type: 'hardlink', mode: 0o644, uid: 0, gid: 0, size: 0, linkTarget: 'usr/bin/perl' },
    ]);
  });

  it('reads character devices and fifos', async () => {
    const archive = tarArchive(tarEntry({ name: 'dev/console', type: '3', mode: 0o600 }), tarEntry({ name: 'run/pipe', type: '6' }));
    const summaries = await readTarSummaries([archive]);
    assert.deepEqual(
      summaries.map((summary) => [summary.path, summary.type]),
      [
        ['dev/console', 'char-device'],
        ['run/pipe', 'fifo'],
      ],
    );
  });

  it('keeps the setuid, setgid and sticky bits and drops file-type bits from the mode', async () => {
    const archive = tarArchive(tarEntry({ name: 'usr/bin/su', mode: 0o104755 }, 'x'), tarEntry({ name: 'tmp/', type: '5', mode: 0o41777 }));
    const summaries = await readTarSummaries([archive]);
    assert.deepEqual(
      summaries.map((summary) => summary.mode),
      [0o4755, 0o1777],
    );
  });

  it('joins the ustar prefix field to the name', async () => {
    const archive = tarArchive(tarEntry({ name: 'dist/index.js', prefix: 'usr/lib/node_modules/some-package' }, 'x'));
    assert.equal((await readTarSummaries([archive]))[0].path, 'usr/lib/node_modules/some-package/dist/index.js');
  });

  it('ignores the prefix area in the old GNU layout, which uses it for other fields', async () => {
    const archive = tarArchive(tarEntry({ name: 'plain.txt', prefix: 'not-a-prefix', gnu: true }, 'x'));
    assert.equal((await readTarSummaries([archive]))[0].path, 'plain.txt');
  });

  it('takes the path, link target, size and owner from a pax header', async () => {
    const longPath = `deep/${'x'.repeat(150)}/file.txt`;
    const longTarget = `/opt/${'y'.repeat(150)}`;
    const archive = tarArchive(
      paxEntry({ path: longPath, uid: '70000', gid: '70001' }),
      tarEntry({ name: 'truncated-name', uid: 7, gid: 7 }, 'content\n'),
      paxEntry({ linkpath: longTarget }),
      tarEntry({ name: 'link', type: '2', linkname: 'truncated-target', mode: 0o777 }),
    );
    const [first, second] = await readTarSummaries([archive]);
    assert.deepEqual(first, file(longPath, 'content\n', { uid: 70000, gid: 70001 }));
    assert.equal(second.linkTarget, longTarget);
  });

  it('reads the data size from a pax header when it overrides the header field', async () => {
    const archive = tarArchive(paxEntry({ size: '5' }), Buffer.concat([tarHeader({ name: 'sized', size: 0 }), Buffer.from('hello'), Buffer.alloc(507)]));
    assert.deepEqual(await readTarSummaries([archive]), [file('sized', 'hello')]);
  });

  it('applies a pax header to the next entry only', async () => {
    const archive = tarArchive(paxEntry({ path: 'renamed' }), tarEntry({ name: 'first' }, 'a'), tarEntry({ name: 'second' }, 'b'));
    const summaries = await readTarSummaries([archive]);
    assert.deepEqual(
      summaries.map((summary) => summary.path),
      ['renamed', 'second'],
    );
  });

  it('skips a pax global header', async () => {
    const archive = tarArchive(paxEntry({ comment: 'made by a test' }, 'g'), tarEntry({ name: 'only' }, 'a'));
    assert.deepEqual(await readTarSummaries([archive]), [file('only', 'a')]);
  });

  it('takes a long name and a long link target from GNU members', async () => {
    const longName = `gnu/${'n'.repeat(130)}/f.txt`;
    const longTarget = `../${'t'.repeat(130)}`;
    const archive = tarArchive(
      gnuLongName(longName),
      tarEntry({ name: 'short', gnu: true }, 'gnu\n'),
      gnuLongName(longTarget, 'K'),
      tarEntry({ name: 'gnu/link', type: '2', linkname: 'short-target', gnu: true }),
    );
    const [named, linked] = await readTarSummaries([archive]);
    assert.equal(named.path, longName);
    assert.equal(named.sha256, sha256('gnu\n'));
    assert.equal(linked.linkTarget, longTarget);
  });

  it('reads a regular-type entry whose name ends in a slash as a directory, as old archives mark one', async () => {
    const archive = tarArchive(tarEntry({ name: 'old-style/', type: '\0', mode: 0o755 }));
    assert.equal((await readTarSummaries([archive]))[0].type, 'directory');
  });

  it('reads a size written in base-256', async () => {
    const header = tarHeader({ name: 'big-number' });
    header.fill(0, 124, 136);
    header[124] = 0x80;
    header[135] = 3;
    rewriteChecksum(header);
    const archive = tarArchive(Buffer.concat([header, Buffer.from('abc'), Buffer.alloc(509)]));
    assert.deepEqual(await readTarSummaries([archive]), [file('big-number', 'abc')]);
  });

  it('gives the same summaries whatever sizes the chunks arrive in', async () => {
    const archive = tarArchive(
      paxEntry({ path: `p/${'z'.repeat(200)}` }),
      tarEntry({ name: 'x' }, 'a'.repeat(1300)),
      tarEntry({ name: 'dir/', type: '5' }),
      tarEntry({ name: 'y' }, 'tail'),
    );
    const whole = await readTarSummaries([archive]);
    for (const size of [1, 7, 511, 513, 4096]) assert.deepEqual(await readTarSummaries(inChunksOf(size, archive)), whole, `chunks of ${size}`);
  });

  it('keeps the content of the regular files it is asked for, and of no other entry', async () => {
    const kept = 'prunedAt: Thu, 01 Jan 2026 00:00:00 GMT\n'.repeat(40);
    const archive = tarArchive(
      tarEntry({ name: 'app/node_modules/.modules.yaml' }, kept),
      tarEntry({ name: 'app/index.js' }, 'console.log(1)\n'),
      tarEntry({ name: 'app/node_modules/', type: '5' }),
    );
    const keepContent = (path) => path.startsWith('app/node_modules');
    for (const size of [1, 7, 511, 4096]) {
      const summaries = await readTarSummaries(inChunksOf(size, archive), { keepContent });
      assert.deepEqual(summaries, [
        { ...file('app/node_modules/.modules.yaml', kept), content: Buffer.from(kept) },
        file('app/index.js', 'console.log(1)\n'),
        { path: 'app/node_modules', type: 'directory', mode: 0o644, uid: 0, gid: 0, size: 0 },
      ], `chunks of ${size}`);
    }
  });

  it('reads from an async stream', async () => {
    const archive = tarArchive(tarEntry({ name: 'streamed' }, 'bytes'));
    async function* stream() {
      yield* inChunksOf(100, archive);
    }
    assert.deepEqual(await readTarSummaries(stream()), [file('streamed', 'bytes')]);
  });

  it('reads the stream to its very end, past the end-of-archive marker', async () => {
    const progress = { finished: false };
    function* chunks() {
      yield tarArchive(tarEntry({ name: 'a' }, 'a'));
      yield Buffer.alloc(10240);
      progress.finished = true;
    }
    await readTarSummaries(chunks());
    assert.equal(progress.finished, true);
  });

  describe('refuses a stream it cannot read', () => {
    it('when a header checksum does not match', async () => {
      const damaged = tarArchive(tarEntry({ name: 'a' }, 'a'));
      damaged[0] = 'b'.charCodeAt(0);
      await assert.rejects(readTarSummaries([damaged]), (error) => error instanceof TarFormatError && /checksum/.test(error.message));
    });

    it('when the stream ends inside a file', async () => {
      const cut = tarEntry({ name: 'a' }, 'a'.repeat(600)).subarray(0, 700);
      await assert.rejects(readTarSummaries([cut]), (error) => error instanceof TarFormatError && /ends inside/.test(error.message));
    });

    it('when the stream ends without the end-of-archive marker', async () => {
      await assert.rejects(readTarSummaries([tarEntry({ name: 'a' }, 'a')]), (error) => error instanceof TarFormatError && /end-of-archive/.test(error.message));
    });

    it('when the stream is empty', async () => {
      await assert.rejects(readTarSummaries([]), TarFormatError);
    });

    it('when an entry has a type the reader does not know', async () => {
      const archive = tarArchive(tarEntry({ name: 'sparse-file', type: 'S' }, 'x'));
      await assert.rejects(readTarSummaries([archive]), (error) => error instanceof TarFormatError && /sparse-file/.test(error.message));
    });

    it('when a pax record is malformed', async () => {
      const archive = tarArchive(tarEntry({ name: 'PaxHeaders/bad', type: 'x' }, '99 path=x\n'), tarEntry({ name: 'a' }, 'a'));
      await assert.rejects(readTarSummaries([archive]), (error) => error instanceof TarFormatError && /pax/.test(error.message));
    });

    it('when a number field is not octal', async () => {
      const header = tarHeader({ name: 'odd' });
      header.write('0000009\0', 100, 8, 'latin1');
      rewriteChecksum(header);
      await assert.rejects(readTarSummaries([Buffer.concat([header, END_OF_ARCHIVE])]), (error) => error instanceof TarFormatError && /mode/.test(error.message));
    });
  });
});
