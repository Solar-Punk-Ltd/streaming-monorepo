import { describe, expect, it } from 'vitest';

import {
  CONNECTED_BY_CONTENT,
  COULD_NOT_REACH,
  failedReadSentence,
  NODE_NOT_READY,
  NOT_A_SWARM_GATEWAY,
  notReadySentence,
  PASSED,
  probeSentence,
  SKIPPED,
  UNREACHABLE_SENTENCES,
} from '../src/components/DomainSelector/checkSentences';
import { DEFAULT_READ_TIMEOUT_MS, PROBE_TIMEOUT_MS } from '../src/swarm/provider';

describe("the sentences a failed check's read ends in", () => {
  it.each([
    [
      { kind: 'not-found', serverTimeMs: null },
      'This gateway answered that the stream list is not there. It may not have found it on the network yet. Test again in a minute, or pick another gateway.',
    ],
    [
      { kind: 'rate-limited', retryAfterMs: 30_000, serverTimeMs: null },
      'This gateway asked to be asked less often. Wait a minute, then test again.',
    ],
    [{ kind: 'unsupported' }, 'This kind of gateway cannot read the stream list. Pick another gateway for it.'],
    [{ kind: 'aborted' }, 'The test was stopped before it finished.'],
    [
      { kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: DEFAULT_READ_TIMEOUT_MS } },
      'The gateway did not answer in 10 s. It may be busy or still starting. Test again in a minute, or pick another gateway.',
    ],
    [
      { kind: 'unavailable', cause: { kind: 'status', status: 503 } },
      'The gateway answered with an error (HTTP 503). Test again in a minute, or pick another gateway.',
    ],
    [{ kind: 'unavailable', cause: { kind: 'network', error: new TypeError('Failed to fetch') } }, COULD_NOT_REACH],
  ] as const)('%o', (answer, sentence) => {
    expect(failedReadSentence('the stream list', answer)).toBe(sentence);
  });

  it("tells a viewer a node may not allow this site, which setting decides it, or that the site's own policy may not allow the node", () => {
    expect(COULD_NOT_REACH).toBe(
      "Could not reach this gateway. Check that the address is right and the node is running. If it is, this node does not allow this site: its cors-allowed-origins setting has to include it. Or this site's own policy does not allow the address, which only whoever runs the site can change.",
    );
  });
});

describe('the sentences the connection check ends in', () => {
  it.each([
    [{ kind: 'ok', elapsedMs: 84 }, 'The gateway answered in 84 ms.'],
    [{ kind: 'not-swarm' }, NOT_A_SWARM_GATEWAY],
    [
      { kind: 'rejected', status: 403 },
      'Something answered at this address with an error (HTTP 403). Check the address and the port.',
    ],
    [
      { kind: 'timed-out' },
      'The gateway did not answer in 5 s. It may be busy or still starting. Test again in a minute, or pick another gateway.',
    ],
    [{ kind: 'unreachable' }, COULD_NOT_REACH],
    [{ kind: 'refuses-this-site' }, UNREACHABLE_SENTENCES['cors-refused']],
  ] as const)('%o', (result, sentence) => {
    expect(probeSentence(result, PROBE_TIMEOUT_MS)).toBe(sentence);
  });
});

describe('the sentences a passed or skipped check ends in', () => {
  it('say what loaded, naming the stream it was tested on', () => {
    expect(PASSED.streamList(12, 41)).toBe('The stream list loaded: 12 streams, entry 41.');
    expect(PASSED.streamList(1, null)).toBe('The stream list loaded: 1 stream.');
    expect(PASSED.playerByMarker('Main stage')).toBe(
      'The video loaded: the time marker of “Main stage”, a playlist and one segment.',
    );
    expect(PASSED.playerByEntry('Main stage')).toBe('The video loaded: a playlist of “Main stage” and one segment.');
    expect(PASSED.previews('Main stage')).toBe('Previews loaded: the preview playlist of “Main stage”.');
    expect(PASSED.picture('Main stage')).toBe('Pictures loaded: the picture of “Main stage”.');
  });

  it('say why a check was not run', () => {
    expect(Object.values(SKIPPED)).toEqual([
      'Not tested: the stream list has no stream to test with.',
      'Not tested: no stream in the list has video yet.',
      'Not tested: no stream in the list has a picture.',
    ]);
  });

  it('use no em-dash and no semicolon', () => {
    const every = [
      COULD_NOT_REACH,
      CONNECTED_BY_CONTENT,
      NOT_A_SWARM_GATEWAY,
      ...Object.values(SKIPPED),
      PASSED.streamList(2, 3),
      PASSED.playerByMarker('x'),
      failedReadSentence('x', { kind: 'unsupported' }),
    ];
    for (const sentence of every) {
      expect(sentence).not.toMatch(/[—;]/);
    }
  });
});

describe('the sentences for a Bee node that answered and cannot serve this viewer yet', () => {
  it.each([
    [{ kind: 'starting' }, 'The Bee node at this address is still starting. Wait a minute, then try again.'],
    [
      { kind: 'no-peers' },
      'The Bee node at this address is running but has no peers yet, so it cannot fetch anything from Swarm. Wait a minute for it to connect, then try again.',
    ],
    [
      { kind: 'too-old', version: '2.2.0', needed: '2.3.0' },
      'This Bee node runs version 2.2.0, and this viewer needs 2.3.0 or newer. Update the node, then try again.',
    ],
  ] as const)('%o', (reason, sentence) => {
    expect(notReadySentence(reason)).toBe(sentence);
    expect(probeSentence({ kind: 'not-ready', reason }, PROBE_TIMEOUT_MS)).toBe(sentence);
  });

  it('names each reason once, for the picker and the Test alike', () => {
    expect(NODE_NOT_READY.tooOld('1.0.0', '2.3.0')).toContain('1.0.0');
  });
});
