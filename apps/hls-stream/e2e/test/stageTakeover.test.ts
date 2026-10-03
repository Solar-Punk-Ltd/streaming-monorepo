import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import { INGEST_RTMP, INGEST_SRT } from '../src/ingestProtocol.js';
import {
  parseStageTakeovers,
  TAKEOVER_ABSENT,
  TAKEOVER_OFF,
  TAKEOVER_ON,
  takeoverUnusable,
} from '../src/stageTakeover.js';

/** An ingest vhost as `engines/srs/entrypoint.sh` writes it, with each protocol's takeover filled in. */
function ingestVhost(srt: string, publish: string | null): string {
  return [
    'vhost __defaultVhost__ {',
    '    srt {',
    '        enabled     on;',
    `        takeover    ${srt};`,
    '    }',
    '',
    ...(publish === null ? [] : ['    publish {', `        takeover    ${publish};`, '    }', '']),
    '    hls {',
    '        enabled         off;',
    '    }',
    '}',
  ].join('\n');
}

/** The ladder's vhost, which never carries a takeover, here given one so a reader that strays into it is caught. */
const LADDER_VHOST_WITH_A_TAKEOVER = ['vhost abr {', '    publish {', '        takeover    on;', '    }', '}'].join(
  '\n',
);

/**
 * Whether the stage a suite is about to publish to takes a stream over, per protocol, read off the config its SRS
 * was started on. The takeover suites depend on it, and a stage that does not take over refuses the reconnect they
 * are about, so this is read before anything is published.
 */
describe('the takeovers a running SRS config carries', () => {
  it('reads each protocol’s takeover out of its own section of the ingest vhost', () => {
    assert.deepEqual(parseStageTakeovers(`listen 10062;\n${ingestVhost('on', 'off')}`), {
      [INGEST_SRT]: TAKEOVER_ON,
      [INGEST_RTMP]: TAKEOVER_OFF,
    });
  });

  it('reads an ingest vhost with no RTMP takeover as a stack from before it existed', () => {
    assert.equal(parseStageTakeovers(ingestVhost('on', null))[INGEST_RTMP], TAKEOVER_ABSENT);
  });

  it('reads the ingest vhost only, never the ladder’s', () => {
    const conf = `${ingestVhost('on', null)}\n\n${LADDER_VHOST_WITH_A_TAKEOVER}\n`;

    assert.equal(parseStageTakeovers(conf)[INGEST_RTMP], TAKEOVER_ABSENT);
  });

  it('refuses a config with no ingest vhost in it, rather than reading every takeover as off', () => {
    assert.throws(() => parseStageTakeovers('listen 1935;\n'), /no `vhost __defaultVhost__`/);
  });

  /**
   * The template the stage renders its config from. If either takeover moved out of the section this reads, every
   * takeover suite would read the stage as one that never takes over.
   */
  it('finds both takeovers where the shipped template writes them', () => {
    const template = readFileSync(join(ROOT_DIR, 'engines', 'srs', 'srs.conf.template'), 'utf8');
    const filled = template.replace('SRT_TAKEOVER_PLACEHOLDER', 'on').replace('RTMP_TAKEOVER_PLACEHOLDER', 'off');

    assert.deepEqual(parseStageTakeovers(filled), { [INGEST_SRT]: TAKEOVER_ON, [INGEST_RTMP]: TAKEOVER_OFF });
  });
});

describe('whether a takeover suite can run against a stage', () => {
  it('runs where the protocol’s takeover is on', () => {
    assert.equal(takeoverUnusable(INGEST_RTMP, { [INGEST_SRT]: TAKEOVER_OFF, [INGEST_RTMP]: TAKEOVER_ON }), null);
  });

  it('stands down, naming the knob, where the deployment turned it off', () => {
    const unusable = takeoverUnusable(INGEST_RTMP, { [INGEST_SRT]: TAKEOVER_ON, [INGEST_RTMP]: TAKEOVER_OFF });

    assert.equal(unusable?.stale, false);
    assert.match(unusable?.reason ?? '', /RTMP_TAKEOVER/);
  });

  it('refuses a stage whose SRS predates the takeover, as a stale deployment rather than a product fault', () => {
    const unusable = takeoverUnusable(INGEST_RTMP, { [INGEST_SRT]: TAKEOVER_ON, [INGEST_RTMP]: TAKEOVER_ABSENT });

    assert.equal(unusable?.stale, true);
    assert.match(unusable?.reason ?? '', /redeploy/i);
  });
});
