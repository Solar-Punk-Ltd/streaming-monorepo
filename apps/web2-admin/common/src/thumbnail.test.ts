import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sniffThumbnailMime } from './thumbnail.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => new TextEncoder().encode(text);

test('a PNG signature is a PNG', () => {
  assert.equal(sniffThumbnailMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)), 'image/png');
});

test('a JPEG start-of-image marker is a JPEG', () => {
  assert.equal(sniffThumbnailMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), 'image/jpeg');
});

test('both GIF versions are GIFs', () => {
  assert.equal(sniffThumbnailMime(ascii('GIF87a')), 'image/gif');
  assert.equal(sniffThumbnailMime(ascii('GIF89a')), 'image/gif');
});

test('a RIFF file of form WEBP is a WebP', () => {
  const head = ascii('RIFF\u0000\u0000\u0000\u0000WEBP');
  assert.equal(sniffThumbnailMime(head), 'image/webp');
});

test('another RIFF file, a WAV, is not a picture', () => {
  assert.equal(sniffThumbnailMime(ascii('RIFF\u0000\u0000\u0000\u0000WAVE')), null);
});

test('a text file renamed to .png is not a picture (SPDV-1668)', () => {
  assert.equal(sniffThumbnailMime(ascii('hello, this is not a picture\n')), null);
});

test('too few bytes to match are not a picture', () => {
  assert.equal(sniffThumbnailMime(bytes(0x89, 0x50)), null);
  assert.equal(sniffThumbnailMime(bytes()), null);
});

test('an SVG, which a browser draws but the feed does not take, is not a thumbnail', () => {
  assert.equal(sniffThumbnailMime(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});
