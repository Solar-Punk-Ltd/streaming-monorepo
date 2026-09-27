/** One quality of a broadcast: its name, its picture size and the bitrate it is encoded at. */
export interface QualityRung {
  name: string;
  width: number;
  height: number;
  kbps: number;
}

/** The ladder a broadcast is encoded to when nothing else is configured, lowest first. */
export const DEFAULT_QUALITY_LADDER: readonly QualityRung[] = [
  { name: '360p', width: 640, height: 360, kbps: 700 },
  { name: '480p', width: 854, height: 480, kbps: 1200 },
  { name: '720p', width: 1280, height: 720, kbps: 2800 },
  { name: '1080p', width: 1920, height: 1080, kbps: 5000 },
];

/**
 * A ladder as the uploader's `ABR_LADDER` setting reads it: `name:width:height:kbps` for each rung, separated by
 * spaces, the tallest first.
 */
export function qualityLadderSpec(rungs: readonly QualityRung[]): string {
  return [...rungs]
    .sort((a, b) => b.height - a.height)
    .map((rung) => `${rung.name}:${rung.width}:${rung.height}:${rung.kbps}`)
    .join(' ');
}
