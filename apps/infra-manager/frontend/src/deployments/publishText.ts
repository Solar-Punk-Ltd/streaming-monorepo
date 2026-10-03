import { rtmpUnencryptedWarning } from '@streaming-infra-manager/common';

import type { RtmpPublishSettings } from '../urls';

/**
 * What the Publish card says beside RTMP: the warning the web2 admin's OBS
 * panel gives a broadcaster, and which of OBS's boxes each value goes in.
 */

/** The warning every console gives beside RTMP, naming a deployment. */
export const RTMP_UNENCRYPTED_WARNING = rtmpUnencryptedWarning('deployment');

/** OBS's names for its two RTMP boxes, which label the values that go in them. */
export const OBS_SERVER_BOX = 'Server';
export const OBS_STREAM_KEY_BOX = 'Stream Key';

export const RTMP_BOXES_NOTE =
  'Each goes in the OBS box of the same name. Change live and stream to your own app and stream name if you use one.';

/**
 * What Copy publish URL puts on the clipboard: the SRT line alone, or, where
 * the deployment also takes RTMP, each value on its own line named by the
 * protocol and the OBS box it goes in, as the Publish card labels them.
 */
export function publishCopyText(srtLine: string, rtmp: RtmpPublishSettings | null): string {
  if (!rtmp) return srtLine;
  return [
    `SRT: ${srtLine}`,
    `RTMP ${OBS_SERVER_BOX}: ${rtmp.server}`,
    `RTMP ${OBS_STREAM_KEY_BOX}: ${rtmp.streamKey}`,
  ].join('\n');
}
