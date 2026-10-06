import { Stack, Typography } from '@mui/material';

import { MONO_STACK } from '../app/theme';
import { CopyBox } from '../components/CopyBox';
import { SectionCard } from '../components/SectionCard';
import { shortHex } from '../format';
import { defaultFeedTopicText } from './feedTopicText';

export function WatchCard({
  url,
  feedOwner,
  feedTopic,
  versionTopic,
  streamerName,
}: {
  url: string;
  feedOwner: string | null | undefined;
  /** The deployment's own topic, or nothing for its version's. */
  feedTopic: string | null | undefined;
  /** The topic the version gives a player that names none, or null while it is not known. */
  versionTopic: string | null;
  /** The stream on this manager that owns the address, when there is one. */
  streamerName: string | null;
}) {
  return (
    <SectionCard title="Watch" sub="the player this deployment serves">
      <Stack spacing={1.25}>
        <CopyBox value={url} href={url} />
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
          }}
        >
          Follows{' '}
          {streamerName ? (
            <Typography component="span" variant="caption" sx={{ fontFamily: MONO_STACK, fontWeight: 600 }}>
              {streamerName}
            </Typography>
          ) : (
            'an external streamer'
          )}{' '}
          · address{' '}
          <Typography component="span" variant="caption" sx={{ fontFamily: MONO_STACK }}>
            {feedOwner ? shortHex(feedOwner) : 'not set'}
          </Typography>{' '}
          · topic{' '}
          <Typography component="span" variant="caption" sx={{ fontFamily: MONO_STACK }}>
            {feedTopic || defaultFeedTopicText(versionTopic)}
          </Typography>
        </Typography>
      </Stack>
    </SectionCard>
  );
}
