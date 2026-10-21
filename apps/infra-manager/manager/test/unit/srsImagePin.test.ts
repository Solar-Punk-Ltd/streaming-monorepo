/**
 * The SRS image the config check isolation harness runs and the engine startup observations were made on,
 * read off the places that name it and checked against the image the stack runs.
 *
 * The harness rests on one sentence: the parser it questions is the parser a
 * deployment gets. That sentence is only true while the image it pins is the
 * image the stack's compose files pin, by digest, and the same image the
 * recorded engine observations were taken on. A digest of a real but different
 * image refuses and accepts exactly like the right one until the stack's
 * config uses a directive only one of them knows, so every place that names
 * the image is held to the stack's own pin here. Nothing here reaches a
 * registry.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SRS_DEFAULT_IMAGE } from '../../src/domain/engineConfig/engineConfigCheck.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, '..', '..', ...parts), 'utf8');
const readStack = (...parts: string[]) => read('..', '..', 'hls-stream', ...parts);

const script = read('test', 'docker', 'srs-check-isolation.sh');
const startupFailure = read('test', 'integration', 'engine-startup-failure.test.ts');
const ci = read('..', 'docs', 'ci.md');

/** The compose files that run SRS in the stack, standalone and deployed. */
const STACK_COMPOSE_FILES = [
  ['engines', 'srs', 'docker-compose.yml'],
  ['deploy', 'docker-compose.yml'],
] as const;

const SRS_SERVICE = 'srs';
const SERVICE_LINE = /^ {2}([\w-]+):\s*$/;
const IMAGE_LINE = /^ {4}image:\s*(\S+)\s*$/;
const DIGEST_RE = /@(sha256:[0-9a-f]{64})/g;
const ONE_DIGEST = /@(sha256:[0-9a-f]{64})$/;

/** The harness exit code for a problem with the harness rather than a wrong answer. */
const HARNESS_PROBLEM = 2;

/** The `image:` of the `srs` service, by the same line scan the manager's stack contract uses. */
function srsImageIn(compose: string): string | null {
  let service: string | null = null;
  for (const line of compose.split('\n')) {
    const serviceMatch = SERVICE_LINE.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1]!;
      continue;
    }
    const imageMatch = IMAGE_LINE.exec(line);
    if (imageMatch && service === SRS_SERVICE) return imageMatch[1]!;
  }
  return null;
}

function digestsIn(text: string): string[] {
  return [...text.matchAll(DIGEST_RE)].map(([, digest]) => digest!);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const stackImages = STACK_COMPOSE_FILES.map((parts) => srsImageIn(readStack(...parts)));
const stackImage = stackImages[0] ?? '';
const stackDigest = ONE_DIGEST.exec(stackImage)?.[1] ?? '';
/** The image's name and tag, the reference without its digest. */
const stackTag = stackImage.split('@')[0] ?? '';

const imageLine = script.split('\n').find((line) => line.startsWith('IMAGE=')) ?? '';
const harnessImage = /^IMAGE="\$\{SRS_CHECK_IMAGE:-([^}]+)\}"$/.exec(imageLine)?.[1] ?? '';

describe('the SRS image the stack runs', () => {
  it('is pinned by digest in both of its compose files, and the two agree', () => {
    for (const [index, image] of stackImages.entries()) {
      assert.ok(image, `${STACK_COMPOSE_FILES[index]!.join('/')} has no image for its srs service`);
      assert.match(image, ONE_DIGEST, `${STACK_COMPOSE_FILES[index]!.join('/')} reaches SRS by tag: ${image}`);
    }
    assert.equal(new Set(stackImages).size, 1, `the compose files run different SRS images: ${stackImages.join(' ')}`);
  });
});

describe('the SRS image the config check isolation harness pins', () => {
  it('is the image the stack runs, by digest', () => {
    assert.equal(harnessImage, stackImage, `the harness runs ${harnessImage}, the stack runs ${stackImage}`);
  });

  it('names one digest and no other', () => {
    assert.deepEqual([...new Set(digestsIn(script))], [stackDigest]);
  });
});

describe('the places that have to agree with it', () => {
  it('is the digest the engine startup observations were made on', () => {
    assert.deepEqual(
      [...new Set(digestsIn(startupFailure))],
      [stackDigest],
      'the parse and the start were recorded on an image the stack does not run',
    );
  });

  it("is the image the manager's config check falls back to when a version names none", () => {
    assert.equal(
      SRS_DEFAULT_IMAGE,
      stackImage,
      `the config check falls back to ${SRS_DEFAULT_IMAGE}, the stack runs ${stackImage}`,
    );
  });

  it('is the digest the pin table in docs/ci.md carries, with the date the stack pinned it', () => {
    const rowRe = new RegExp(
      `\\|\\s*\`${escapeRegExp(stackTag)}\`\\s*\\|\\s*\`(sha256:[0-9a-f]{64})\`\\s*\\|\\s*(\\d{4}-\\d{2}-\\d{2})\\s*\\|`,
    );
    const row = ci.match(rowRe);
    assert.ok(row, `docs/ci.md has no pin row for ${stackTag}`);
    assert.equal(row[1], stackDigest, 'the pin table names an image the stack does not run');
    assert.match(row[2]!, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('an image the operator names instead', () => {
  const run = (image: string) =>
    spawnSync('bash', [join(here, '..', 'docker', 'srs-check-isolation.sh')], {
      env: { ...process.env, SRS_CHECK_IMAGE: image },
      encoding: 'utf8',
    });

  it('is refused unless it is a digest, because a tag can move under the check', () => {
    const { status, stderr } = run(stackTag);
    assert.equal(status, HARNESS_PROBLEM, stderr);
    assert.match(stderr, /SRS_CHECK_IMAGE/);
    assert.match(stderr, /@sha256:/);
  });
});
