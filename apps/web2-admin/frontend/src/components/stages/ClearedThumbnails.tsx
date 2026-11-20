import { Link as RouterLink } from 'react-router';
import { Alert, Link, Stack, Typography } from '@mui/material';
import type { ClearedThumbnail } from '@streaming-monorepo/web2-admin-common';

/** Said above the streams whose thumbnail a move cleared. */
export function clearedThumbnailsText(count: number): string {
  const streams = count === 1 ? 'One stream lost its thumbnail' : `${count} streams lost their thumbnails`;
  return `${streams}: the old batch had lapsed and the network no longer held the image, so the move cleared it and went on. Give each a new one on its page.`;
}

/**
 * The streams whose thumbnail a move of the catalogue cleared, each a link to its page, where it takes a new one. Shown
 * on the Stages page's move card and under a catalogue purchase on the Stamps tab; nothing while there are none.
 */
export function ClearedThumbnails({ streams }: { streams: readonly ClearedThumbnail[] | undefined }) {
  if (!streams || streams.length === 0) return null;
  return (
    <Alert severity="warning">
      <Stack spacing={0.5}>
        <Typography variant="body2">{clearedThumbnailsText(streams.length)}</Typography>
        <Stack component="ul" aria-label="Cleared thumbnails" sx={{ m: 0, pl: 2.5 }}>
          {streams.map((stream) => (
            <li key={stream.streamId}>
              <Link component={RouterLink} to={`/streams/${stream.streamId}`} variant="body2">
                {stream.title}
              </Link>
            </li>
          ))}
        </Stack>
      </Stack>
    </Alert>
  );
}
