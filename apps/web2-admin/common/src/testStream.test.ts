import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTestLeftRunning,
  storedViewerUrl,
  TEST_STREAM_LEFT_RUNNING_SECONDS,
  TEST_STREAM_REFUSALS,
  testStreamViewerUrlPath,
  VIEWER_URL_MAX,
  viewerUrlProblem,
  watchPagePath,
  watchPageUrl,
} from './testStream.js';

const stream = { mediaType: 'video' as const, owner: 'ab'.repeat(20), topic: '1867808f-7b1c-4e46-b437-f7423b466001' };

test('a watch page is the hash route both viewers share', () => {
  assert.equal(watchPagePath(stream), `#/watch/video/${stream.owner}/${stream.topic}`);
  assert.equal(watchPagePath({ ...stream, mediaType: 'audio' }), `#/watch/audio/${stream.owner}/${stream.topic}`);
});

test("a watch address is the viewer's address with the route as its fragment, whatever the address holds", () => {
  const route = watchPagePath(stream);
  const cases: Array<[string, string]> = [
    ['http://203.0.113.7:10004', `http://203.0.113.7:10004/${route}`],
    ['http://203.0.113.7:10004/', `http://203.0.113.7:10004/${route}`],
    ['  http://localhost:5173  ', `http://localhost:5173/${route}`],
    ['https://team.example.com/viewer', `https://team.example.com/viewer${route}`],
    ['https://team.example.com/viewer/', `https://team.example.com/viewer/${route}`],
    ['https://team.example.com/?list=1', `https://team.example.com/?list=1${route}`],
    ['http://[2001:db8::7]:10004', `http://[2001:db8::7]:10004/${route}`],
    ['https://team:secret@team.example.com', `https://team:secret@team.example.com/${route}`],
  ];
  for (const [given, expected] of cases) assert.equal(watchPageUrl(given, stream), expected, given);
});

test("a fragment the address already has gives way to the stream's route", () => {
  const route = watchPagePath(stream);
  assert.equal(watchPageUrl('http://203.0.113.7:10004/#/', stream), `http://203.0.113.7:10004/${route}`);
  assert.equal(
    watchPageUrl('https://team.example.com/viewer/#/watch/audio/someone/else', stream),
    `https://team.example.com/viewer/${route}`,
  );
  assert.equal(watchPageUrl('team.example.com#/', stream), `team.example.com${route}`);
});

test('a viewer address is anything that starts with http:// or https:// and reads as a URL', () => {
  for (const address of [
    'http://203.0.113.7:10004',
    'http://stage.example.com:10004/',
    'https://team.example.com/viewer',
    'https://gateway.example.com/bzz/team-viewer.eth/',
    'http://localhost:5173',
    'http://203.0.113.7:10004/#/',
    'https://team.example.com/?list=1#/watch/video/a/b',
    'https://team:secret@team.example.com',
    'http://[2001:db8::7]:10004',
    'HTTPS://Team.Example.com',
    '  https://team.example.com  ',
  ]) {
    assert.equal(viewerUrlProblem(address), null, address);
  }
});

test('a viewer address of another kind is refused with a sentence', () => {
  for (const address of [
    '',
    'team.example.com',
    'ftp://team.example.com',
    'javascript:alert(1)',
    'https://',
    'http:// a',
  ]) {
    assert.match(viewerUrlProblem(address) ?? '', /^The viewer's address starts with http:\/\/ or https:\/\//, address);
  }
  const long = `https://team.example.com/${'a'.repeat(VIEWER_URL_MAX)}`;
  assert.match(viewerUrlProblem(long) ?? '', /at most 2000 characters/);
});

test('an address is stored as given without the spaces around it, and an empty one as null', () => {
  assert.equal(storedViewerUrl('  https://team.example.com/viewer/  '), 'https://team.example.com/viewer/');
  assert.equal(storedViewerUrl('http://203.0.113.7:10004/#/'), 'http://203.0.113.7:10004/#/');
  assert.equal(storedViewerUrl(''), null);
  assert.equal(storedViewerUrl('   '), null);
  assert.equal(storedViewerUrl(null), null);
});

test('the viewer address of a test stream is set on a route of that stream', () => {
  assert.equal(testStreamViewerUrlPath('4f0c'), '/api/streams/4f0c/viewer-url');
});

test('a test stream is left running once it has been live for more than an hour', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');
  const since = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
  const live = { test: true, status: 'live' as const };

  assert.equal(isTestLeftRunning({ ...live, liveSince: since(TEST_STREAM_LEFT_RUNNING_SECONDS) }, now), false);
  assert.equal(isTestLeftRunning({ ...live, liveSince: since(TEST_STREAM_LEFT_RUNNING_SECONDS + 1) }, now), true);
});

test('only a live test stream is ever left running', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');
  const longAgo = '2026-11-23T08:00:00.000Z';

  assert.equal(isTestLeftRunning({ test: false, status: 'live', liveSince: longAgo }, now), false);
  assert.equal(isTestLeftRunning({ test: true, status: 'vod', liveSince: longAgo }, now), false);
  assert.equal(isTestLeftRunning({ test: true, status: 'live', liveSince: null }, now), false);
  assert.equal(isTestLeftRunning({ test: true, status: 'live' }, now), false);
});

test('every refusal has a sentence of its own', () => {
  const sentences = Object.values(TEST_STREAM_REFUSALS);
  assert.equal(sentences.length, 4);
  assert.equal(new Set(sentences).size, 4);
  for (const sentence of sentences) assert.match(sentence, /^A test stream /);
});
