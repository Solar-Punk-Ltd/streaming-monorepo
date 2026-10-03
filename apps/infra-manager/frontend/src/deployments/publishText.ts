/**
 * What the Publish card says beside RTMP: the warning the web2 admin's OBS
 * panel gives a broadcaster, and which of OBS's boxes each value goes in.
 */

/** RTMP has no passphrase, so its stream key travels in clear text to anyone on the path. */
export const RTMP_UNENCRYPTED_WARNING =
  'RTMP is not encrypted. Your stream key crosses the network as readable text, and anyone who reads it there can publish to this stream with it. On a deployment that lets a reconnecting encoder replace one whose connection dropped, they can also replace your live broadcast with theirs. On a network you do not trust, broadcast over SRT with a passphrase instead.';

/** OBS's names for its two RTMP boxes, which label the values that go in them. */
export const OBS_SERVER_BOX = 'Server';
export const OBS_STREAM_KEY_BOX = 'Stream Key';

export const RTMP_BOXES_NOTE =
  'Each goes in the OBS box of the same name. Change live and stream to your own app and stream name if you use one.';
