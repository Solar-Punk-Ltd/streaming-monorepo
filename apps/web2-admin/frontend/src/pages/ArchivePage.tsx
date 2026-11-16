import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  ARCHIVE_UNLISTED_TEXT,
  type ArchivedStream,
  type ArchiveStamp,
  type QualityArchiveState,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { ArchiveBadge } from '../components/archive/ArchiveBadge';
import { bareBatchId, formatCapacity } from '../components/archive/archiveText';
import { formatDateTime } from '../dateUtil';
import { errorMessage } from '../errors';
import { formatTimeLeft, shortHex } from '../format';

/** Said on the page with no stream archived. */
export const NO_ARCHIVES = 'No stream is archived yet.';

/** What the page is, under its title. */
export const ARCHIVE_PAGE_INTRO =
  'The streams whose recordings are copied onto archive stamps, which keep them on Swarm after their stage batches expire. A copy stays on its stamp for the stamp’s life.';

/** One quality's copy, in words. */
export const QUALITY_STATE_TEXT: Readonly<Record<QualityArchiveState, string>> = {
  none: 'Not archived',
  partial: 'Incomplete',
  complete: 'Archived',
  reduced: 'Archived, reduced protection',
  unlisted: 'Archived, stamp not listed',
  outdated: 'Outdated: recorded again since',
  expired: 'Expired with its stamp',
};

/** The qualities of a stream whose copy is outdated, which "Archive again" copies anew. */
function outdatedQualities(stream: ArchivedStream): string[] {
  return stream.qualities.filter((quality) => quality.state === 'outdated').map((quality) => quality.rendition);
}

type Quality = ArchivedStream['qualities'][number];

/**
 * One quality: its label and state, the parity chunks it lost when protection is reduced, and why a stamp no longer
 * listed matters.
 */
function QualityLine({ quality }: { quality: Quality }) {
  const lost =
    quality.state === 'reduced' && quality.parityMissing > 0
      ? `, ${quality.parityMissing.toLocaleString('en-US')} parity chunks missing`
      : '';
  const warn =
    quality.state === 'partial' ||
    quality.state === 'reduced' ||
    quality.state === 'unlisted' ||
    quality.state === 'outdated';
  const line = (
    <Typography
      variant="body2"
      noWrap
      sx={{ color: quality.state === 'expired' ? 'error.main' : warn ? 'warning.main' : 'text.primary' }}
    >
      {`${quality.label}: ${QUALITY_STATE_TEXT[quality.state]}${lost}`}
    </Typography>
  );
  if (quality.state !== 'unlisted') return line;
  return (
    <Box>
      {line}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', maxWidth: 360 }}>
        {ARCHIVE_UNLISTED_TEXT}
      </Typography>
    </Box>
  );
}

/** The stamp a quality's copy is on: its label, or its short id, with its time left, in amber when it runs low. */
function StampLine({ quality, stamp }: { quality: Quality; stamp: ArchiveStamp | undefined }) {
  if (quality.batchId === null) return <Typography variant="body2">—</Typography>;
  const name = quality.batchLabel ?? shortHex(quality.batchId);
  const ttl = quality.batchTtlSeconds ?? stamp?.ttlSeconds ?? null;
  const low = stamp?.expiresSoon ?? false;
  return (
    <Typography variant="body2" noWrap title={quality.batchId}>
      {name}
      <Box component="span" sx={{ color: low ? 'warning.main' : 'text.secondary' }}>
        {` · ${ttl === 0 ? 'expired' : `${formatTimeLeft(ttl)} left`}`}
      </Box>
    </Typography>
  );
}

/**
 * The Archive page's content: a row per stream that has an archive, newest copy first, with its title and badge, its
 * date, each copied quality and its state, the size of what is archived, the stamp each copy is on with its time left,
 * and when and by whom its newest copy was completed. `onArchive`, when given, opens the archive panel on the stream:
 * "Archive more qualities" with nothing ticked, "Archive again" with its outdated qualities ticked. Nothing is ever
 * removed from a stamp, so there is no un-archive.
 */
export function ArchivePageView({
  streams,
  stamps,
  onArchive,
}: {
  streams: readonly ArchivedStream[];
  /** The archive stamps as the admin read them, by `bareBatchId`, for their time left and their warning. */
  stamps: ReadonlyMap<string, ArchiveStamp>;
  onArchive?: (streamId: string, preselect?: readonly string[]) => void;
}) {
  if (streams.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {NO_ARCHIVES}
        </Typography>
      </Paper>
    );
  }
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" aria-label="Archived streams">
        <TableHead>
          <TableRow>
            <TableCell>Stream</TableCell>
            <TableCell>Date</TableCell>
            <TableCell>Qualities</TableCell>
            <TableCell align="right">Size</TableCell>
            <TableCell>Stamp</TableCell>
            <TableCell>Archived</TableCell>
            {onArchive ? <TableCell align="right">Actions</TableCell> : null}
          </TableRow>
        </TableHead>
        <TableBody>
          {streams.map((stream) => {
            const outdated = outdatedQualities(stream);
            return (
              <TableRow key={stream.streamId} hover sx={{ verticalAlign: 'top' }}>
                <TableCell sx={{ minWidth: 180, maxWidth: 320 }}>
                  <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                    <Link component={RouterLink} to={`/streams/${stream.streamId}`} sx={{ overflowWrap: 'anywhere' }}>
                      {stream.title}
                    </Link>
                    <ArchiveBadge archive={stream.summary} />
                  </Stack>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{stream.date ?? '—'}</TableCell>
                <TableCell>
                  <Stack spacing={0.25}>
                    {stream.qualities.map((quality) => (
                      <QualityLine key={quality.rendition} quality={quality} />
                    ))}
                  </Stack>
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {formatCapacity(stream.bytes)}
                </TableCell>
                <TableCell>
                  <Stack spacing={0.25}>
                    {stream.qualities.map((quality) => (
                      <StampLine
                        key={quality.rendition}
                        quality={quality}
                        stamp={quality.batchId === null ? undefined : stamps.get(bareBatchId(quality.batchId))}
                      />
                    ))}
                  </Stack>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Typography variant="body2">{formatDateTime(stream.archivedAt)}</Typography>
                  {stream.archivedBy ? (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      by {stream.archivedBy}
                    </Typography>
                  ) : null}
                </TableCell>
                {onArchive ? (
                  <TableCell align="right">
                    <Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
                      {outdated.length > 0 ? (
                        <Button size="small" variant="outlined" onClick={() => onArchive(stream.streamId, outdated)}>
                          Archive again
                        </Button>
                      ) : null}
                      <Button size="small" onClick={() => onArchive(stream.streamId)} sx={{ whiteSpace: 'nowrap' }}>
                        Archive more qualities
                      </Button>
                    </Stack>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * The Archive page, `/archive`: only the streams that have an archive, read from `GET /api/archive/streams`, with the
 * archive stamps from `GET /api/archive/stamps` for their warning. Stamps that could not be read leave the rows
 * without the warning, nothing else. `onArchive` opens the archive panel; with none, the page offers no action.
 */
export function ArchivePage({ onArchive }: { onArchive?: (streamId: string, preselect?: readonly string[]) => void }) {
  const [streams, setStreams] = useState<ArchivedStream[] | null>(null);
  const [stamps, setStamps] = useState<ReadonlyMap<string, ArchiveStamp>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .fetchArchivedStreams()
      .then(setStreams)
      .catch((e: unknown) => setError(errorMessage(e, 'The archived streams could not be read.')));
    api
      .fetchArchiveStamps()
      .then((answer) => setStamps(new Map(answer.stamps.map((stamp) => [bareBatchId(stamp.batchId), stamp]))))
      .catch(() => setStamps(new Map()));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          Archive
        </Typography>
        <Tooltip title="Refresh">
          <IconButton aria-label="refresh the archive" onClick={load}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {ARCHIVE_PAGE_INTRO}
      </Typography>
      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}
      {!streams && !error ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress aria-label="Loading the archive" />
        </Box>
      ) : null}
      {streams ? <ArchivePageView streams={streams} stamps={stamps} onArchive={onArchive} /> : null}
    </Stack>
  );
}
