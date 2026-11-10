/**
 * The name an exported MP4 is saved under: the stream's title, the day the broadcast started and the quality, as
 * `opening-keynote-2026-11-05-1080p.mp4`, with `-partial` before the extension when it was saved from part of the
 * recording.
 */

/** Long enough for any real title, short enough for every file system's name limit with the rest added. */
const TITLE_MAX_LENGTH = 80;

/** The title in lower-case ASCII letters and digits, words joined by `-`; `stream` when nothing is left. */
export function slugTitle(title: string): string {
  const ascii = title.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= TITLE_MAX_LENGTH) return slug || 'stream';
  // Cut at the last whole word that fits, or at the limit when one word fills it.
  const cut = slug.slice(0, TITLE_MAX_LENGTH);
  const atWord = cut.slice(0, cut.lastIndexOf('-'));
  return (atWord || cut).replace(/-+$/, '');
}

/** `YYYY-MM-DD`, in UTC. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The day the broadcast started, in UTC: when it went live, else when it was scheduled, else when it ended. Null for
 * a stream with none of them, and the caller falls back to the export's own day.
 */
export function broadcastDay(stream: {
  live_since: Date | null;
  scheduled_start_time: Date | null;
  ended_at: Date | null;
}): string | null {
  const when = stream.live_since ?? stream.scheduled_start_time ?? stream.ended_at;
  return when ? utcDay(when) : null;
}

export function exportFileName(parts: { title: string; day: string; quality: string; partial: boolean }): string {
  const quality =
    parts.quality
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'source';
  return `${slugTitle(parts.title)}-${parts.day}-${quality}${parts.partial ? '-partial' : ''}.mp4`;
}
