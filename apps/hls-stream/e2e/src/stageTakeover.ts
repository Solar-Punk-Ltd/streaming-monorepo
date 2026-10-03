/**
 * Whether the stage's SRS takes a stream over from a publisher it still holds, per protocol, read off the config the
 * running container was started on.
 *
 * `engines/srs/entrypoint.sh` decides each takeover when the container starts, from `SRT_TAKEOVER` and `RTMP_TAKEOVER`
 * or, when those are unset, from whether the uploader checks publish keys. So the config it generated is the one place
 * that says what the stage does now, for the reason `harness/stage.ts` gives about reading the segment length there.
 * A suite whose broadcaster reconnects over a connection SRS still holds needs the takeover, because without it SRS
 * refuses that reconnect as busy, and the suite reads this before it publishes anything.
 */

import { INGEST_RTMP, INGEST_SRT, type IngestProtocol, PROTOCOL_LABEL } from './ingestProtocol.js';

export const TAKEOVER_ON = 'on';
export const TAKEOVER_OFF = 'off';
/** The ingest vhost carries no such directive, which is a stack from before the takeover existed. */
export const TAKEOVER_ABSENT = 'absent';
export type TakeoverSetting = typeof TAKEOVER_ON | typeof TAKEOVER_OFF | typeof TAKEOVER_ABSENT;

export type StageTakeovers = Record<IngestProtocol, TakeoverSetting>;

/** The section of the ingest vhost each protocol's takeover is the `takeover` of. */
const TAKEOVER_SECTION: Record<IngestProtocol, string> = { [INGEST_SRT]: 'srt', [INGEST_RTMP]: 'publish' };

/** The env knob that decides each takeover, which is what a refusal tells an operator to change. */
const TAKEOVER_KNOB: Record<IngestProtocol, string> = {
  [INGEST_SRT]: 'SRT_TAKEOVER',
  [INGEST_RTMP]: 'RTMP_TAKEOVER',
};

const INGEST_VHOST_OPENING = 'vhost __defaultVhost__ {';

/**
 * The ingest vhost's block, by brace depth. Only this vhost is read: the ladder's vhost never carries a takeover, and
 * a match over the whole file could read one there.
 */
function ingestVhostBlock(conf: string): string {
  const start = conf.indexOf(INGEST_VHOST_OPENING);
  if (start === -1) {
    throw new Error(
      'the running SRS config has no `vhost __defaultVhost__` block, so whether it takes a stream over cannot be ' +
        'read. That is a config this harness does not know, rather than a stage that takes nothing over.',
    );
  }
  let depth = 0;
  for (let at = conf.indexOf('{', start); at < conf.length; at += 1) {
    if (conf[at] === '{') {
      depth += 1;
    } else if (conf[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        return conf.slice(start, at + 1);
      }
    }
  }
  throw new Error('the running SRS config never closes its `vhost __defaultVhost__` block');
}

function settingIn(vhost: string, section: string): TakeoverSetting {
  const body = new RegExp(`^\\s*${section}\\s*\\{([^}]*)\\}`, 'm').exec(vhost)?.[1];
  const value = body === undefined ? undefined : /^\s*takeover\s+(\S+);/m.exec(body)?.[1];
  if (value === TAKEOVER_ON || value === TAKEOVER_OFF) {
    return value;
  }
  return TAKEOVER_ABSENT;
}

export function parseStageTakeovers(conf: string): StageTakeovers {
  const vhost = ingestVhostBlock(conf);
  return {
    [INGEST_SRT]: settingIn(vhost, TAKEOVER_SECTION[INGEST_SRT]),
    [INGEST_RTMP]: settingIn(vhost, TAKEOVER_SECTION[INGEST_RTMP]),
  };
}

/** Why a suite that needs this takeover cannot run against a stage. */
export interface TakeoverUnusable {
  /**
   * True for a stage whose SRS predates the takeover, which is a deployment to redeploy and fails the suite. False
   * for one whose operator turned it off, where the suite does not apply and stands down.
   */
  stale: boolean;
  reason: string;
}

/** Why a suite that needs `protocol`'s takeover cannot run against a stage carrying `takeovers`, or null when it can. */
export function takeoverUnusable(protocol: IngestProtocol, takeovers: StageTakeovers): TakeoverUnusable | null {
  const label = PROTOCOL_LABEL[protocol];
  switch (takeovers[protocol]) {
    case TAKEOVER_ON:
      return null;
    case TAKEOVER_OFF:
      return {
        stale: false,
        reason:
          `the stage turns the ${label} takeover off, through ${TAKEOVER_KNOB[protocol]} or because its uploader ` +
          `checks no publish key, so SRS refuses a ${label} reconnect over a connection it still holds and there is ` +
          'no takeover to observe',
      };
    case TAKEOVER_ABSENT:
      return {
        stale: true,
        reason:
          `the stage's SRS config has no ${label} takeover in its ingest vhost, so it runs a stack from before ` +
          `${TAKEOVER_KNOB[protocol]} existed. Redeploy SRS from this checkout (deploy/scripts/deploy.sh ... srs) on ` +
          'the fork image the compose files pin, and run again.',
      };
  }
}
