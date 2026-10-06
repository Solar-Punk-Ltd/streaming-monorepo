/**
 * Whether each VOD catalog entry's recording, named by its reference, is a finished playlist a thumbnail can be
 * taken from, and how long that one read takes.
 *
 * This probe once compared an entry's feed index with its feed head, for fix 2 of
 * `docs/reviews/catalog-off-the-head-lookup.md`. A recording is now named by its reference alone and read with
 * `GET /bytes/<recording>`, so the question left is whether that read answers a playlist carrying
 * `#EXT-X-ENDLIST`. The file keeps its name so the review's link still resolves.
 *
 * Reads the real catalog, so it needs no deploy and no broadcast.
 */
import { Topic } from '@ethersphere/bee-js';

import { probeReadUrl } from './bee-urls.mjs';

const READ_URL = probeReadUrl();
const APP_OWNER = process.env.APP_OWNER;
const APP_RAW_TOPIC = process.env.APP_RAW_TOPIC;
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES ?? 12);
const REQUEST_TIMEOUT_MS = 30_000;

async function timed(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await response.text();
    return { ms: Date.now() - startedAt, status: response.status, body };
  } catch {
    return { ms: Date.now() - startedAt, status: 0, body: '' };
  }
}

function stats(v) {
  if (v.length === 0) {
    return { n: 0, min: 0, median: 0, max: 0 };
  }
  const s = [...v].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

/** A playlist body in a few words, for a readable report. */
function shape(body) {
  const segments = (body.match(/^#EXTINF/gm) ?? []).length;
  const vod = body.includes('#EXT-X-ENDLIST');
  return `${body.length}B ${segments}seg ${vod ? 'VOD' : 'not finished'}`;
}

const appTopic = Topic.fromString(APP_RAW_TOPIC);
const catalog = await timed(`${READ_URL}/feeds/${APP_OWNER}/${appTopic.toString()}`);
if (catalog.status !== 200) {
  console.log(`catalog head lookup failed with ${catalog.status}`);
  process.exit(1);
}

const entries = JSON.parse(catalog.body);
const withRecording = entries.filter((e) => e.state === 'vod' && typeof e.recording === 'string');
console.log(`catalog: ${entries.length} entries, ${withRecording.length} name a recording, sampling ${MAX_ENTRIES}\n`);

const sample = withRecording.slice(-MAX_ENTRIES);
const readMs = [];
let finished = 0;
let unfinished = 0;
let missing = 0;

for (const entry of sample) {
  const read = await timed(`${READ_URL}/bytes/${entry.recording}`);
  readMs.push(read.ms);

  if (read.status !== 200) {
    missing += 1;
    console.log(`MISS  ${entry.topic.slice(0, 8)} recording ${entry.recording.slice(0, 12)} status ${read.status}`);
    continue;
  }
  if (read.body.includes('#EXT-X-ENDLIST')) {
    finished += 1;
    console.log(`ok    ${entry.topic.slice(0, 8)} ${shape(read.body)} in ${read.ms}ms`);
    continue;
  }
  unfinished += 1;
  console.log(`OPEN  ${entry.topic.slice(0, 8)} ${shape(read.body)}`);
}

const r = stats(readMs);
console.log(`\nread by reference: min ${r.min}ms, median ${r.median}ms, max ${r.max}ms`);
console.log(`\nfinished ${finished}, not finished ${unfinished}, missing ${missing}, of ${sample.length}`);
