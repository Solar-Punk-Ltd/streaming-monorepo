import { Chip, CircularProgress, Stack, Tooltip } from '@mui/material';
import type {
  MediaType,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

type ChipColor = 'default' | 'success' | 'warning' | 'error' | 'info';

const STATUS_COLOR: Record<StreamStatus, ChipColor> = {
  draft: 'default',
  publishing: 'info',
  published: 'success',
  live: 'error',
  vod: 'info',
};

const STATUS_LABEL: Record<StreamStatus, string> = {
  draft: 'Draft',
  publishing: 'Publishing',
  published: 'Published',
  live: 'Live',
  vod: 'VOD',
};

export function StatusChip({
  status,
  publishError,
}: {
  status: StreamStatus;
  publishError?: string | null;
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Chip
        size="small"
        label={STATUS_LABEL[status]}
        color={STATUS_COLOR[status]}
        variant={status === 'draft' ? 'outlined' : 'filled'}
        icon={
          status === 'publishing' ? (
            <CircularProgress size={12} color="inherit" />
          ) : undefined
        }
      />
      {publishError ? (
        <Tooltip title={publishError}>
          <Chip
            size="small"
            label="Publish failed"
            color="error"
            variant="outlined"
          />
        </Tooltip>
      ) : null}
    </Stack>
  );
}

const MEDIA_TYPE_LABEL: Record<MediaType, string> = {
  video: 'Video Stream',
  audio: 'Audio Only',
};

export function MediaTypeChip({ mediaType }: { mediaType: MediaType }) {
  return (
    <Chip size="small" variant="outlined" label={MEDIA_TYPE_LABEL[mediaType]} />
  );
}

export { MEDIA_TYPE_LABEL };
