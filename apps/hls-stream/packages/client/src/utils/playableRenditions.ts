import { Rendition, Stream, STREAM_STATUS_VOD, type StreamRecording } from '@/types/stream';

/**
 * The rungs of a catalog entry a viewer can be handed: every rung of a live ladder, and only the rungs
 * that have a recording once the ladder is one.
 *
 * ⛔ 2026-09-23: 1080p's postage batch refused its recording, so its ladder finished without it. The
 * uploader's own catalog entry then leaves that rung out of `renditions`. The admin's entry cannot, and
 * lists it without an index, over a feed whose last playlist is a live one that will never end. The
 * recording's master already names only the rungs that recorded, so nothing plays it, and this keeps
 * the player from walking that feed for as long as the recording is watched.
 */
export function playableRenditions(stream: Pick<Stream, 'state' | 'renditions'> | undefined): Rendition[] | undefined {
  const renditions = stream?.renditions;
  if (renditions === undefined || stream?.state !== STREAM_STATUS_VOD) {
    return renditions;
  }
  return renditions.filter((rendition) => rendition.index !== undefined);
}

/**
 * What the player reads a finished entry by, or undefined for any other entry, which is searched.
 *
 * ⛔ Once a stream's stage stamps run out, only the archive's copy is left on Swarm: the master at the
 * entry's `index` and each rung's final playlist at its rendition's `index`. Every earlier slot and the
 * feed head lookup answer 404, so a recording is read only at the slots its entry names. A live entry
 * keeps the search, as the card's `finishedRungIndex` does, since a slot it names is an old playlist.
 */
export function recordingOf(stream: Pick<Stream, 'state' | 'index'> | undefined): StreamRecording | undefined {
  if (stream?.state !== STREAM_STATUS_VOD) {
    return undefined;
  }
  return { index: stream.index };
}
