import { useCallback, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { Button, ButtonVariant } from '@/components/Button/Button';
import { SwarmHlsPlayer } from '@/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { useAppContext } from '@/providers/App';
import { watchPageCatalogPollMs } from '@/providers/catalogPoll';
import { useCatalogPoll } from '@/providers/useCatalogPoll';
import { ROUTES } from '@/routes';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';
import { playableRenditions } from '@/utils/playableRenditions';
import { scheduledStartLabel } from '@/utils/scheduledStart';
import { WATCH_VIEW_PLAYER, watchPageView } from '@/utils/watchPageView';

import { useIsWaitingForStart } from './useIsWaitingForStart';
import { WatchPlaceholder } from './WatchPlaceholder';

import './StreamWatcher.scss';

const VALID_MEDIA_TYPES: MediaType[] = [MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO];

function isMediaType(value: string): value is MediaType {
  return VALID_MEDIA_TYPES.includes(value as MediaType);
}

export function StreamWatcher() {
  const { mediatype, owner, topic } = useParams<{
    mediatype: string;
    owner: string;
    topic: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { streamList, isStreamListLoaded } = useAppContext();

  // The ladder lives in the catalog, keyed by the primary feed the browser links to. Current
  // entries name the master, older ones the lowest rung. Waiting for the first catalog read
  // rather than rendering without
  // it keeps a deep link from starting single-rendition and rebuilding a second later.
  const stream = streamList.find((entry) => entry.owner === owner && entry.topic === topic);

  // Above the early return, because a hook may not be skipped on some renders.
  const streamKey = `${owner}/${topic}`;
  const isWaiting = useIsWaitingForStart(streamKey, stream);
  const view = watchPageView(isStreamListLoaded, stream, isWaiting);
  // Kept per stream, because React Router keeps this page mounted when only the route changes.
  const [shortLadderOf, setShortLadderOf] = useState<string | null>(null);
  const onLadderIncomplete = useCallback(
    (incomplete: boolean) => setShortLadderOf(incomplete ? streamKey : null),
    [streamKey],
  );
  useCatalogPoll(watchPageCatalogPollMs(view, shortLadderOf === streamKey));

  const handleBackButtonClick = () => {
    navigate(ROUTES.STREAM_BROWSER);
  };

  if (!mediatype || !owner || !topic || !isMediaType(mediatype)) {
    return <div>Invalid stream</div>;
  }

  const enableQoeOverlay = searchParams.get('qoe') === '1';
  // ?level=<rung name> pins playback to one rung, ?level=auto hands the choice to ABR. The route
  // carries no ladder of its own, so the rung names come from the catalog entry below.
  const level = searchParams.get('level') ?? undefined;

  // Neither message mounts the player. An announced broadcast has no manifest feed under its topic
  // yet, so a player there polls a slot nobody writes and loads for ever. See `watchPageView`.
  const startsAt = scheduledStartLabel(stream?.scheduledStartTime);

  return (
    <div className="stream-item-page">
      <WatchPlaceholder view={view} startsAt={startsAt} />
      {view === WATCH_VIEW_PLAYER && (
        <SwarmHlsPlayer
          owner={owner}
          topicString={topic}
          mediaType={mediatype}
          enableQoeOverlay={enableQoeOverlay}
          renditions={playableRenditions(stream)}
          level={level}
          onLadderIncomplete={onLadderIncomplete}
        />
      )}
      <Button variant={ButtonVariant.SECONDARY} onClick={() => handleBackButtonClick()}>
        Back
      </Button>
    </div>
  );
}
