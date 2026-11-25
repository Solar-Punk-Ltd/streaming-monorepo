import { useCallback, useEffect, useMemo, useState } from 'react';
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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  ARCHIVE_THUMBNAIL_TEXT,
  ARCHIVE_UNLISTED_TEXT,
  isArchived,
  orderArchiveCopies,
  type ArchiveCopy,
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

/** The stamp filter's value that lists every stream with every copy. */
export const ALL_STAMPS = 'all';

/** The qualities of a stream whose copy is outdated, which "Archive again" copies anew. */
function outdatedQualities(stream: ArchivedStream): string[] {
  return stream.qualities.filter((quality) => quality.state === 'outdated').map((quality) => quality.rendition);
}

/** The qualities of a stream that play from an archive stamp, which "Copy onto another stamp" offers. */
export function archivedQualities(stream: ArchivedStream): string[] {
  return stream.qualities.filter((quality) => isArchived(quality.state)).map((quality) => quality.rendition);
}

/** A stamp the filter offers: one that holds a copy, by its bare id, with its label or its short id. */
export interface ArchiveStampChoice {
  batchId: string;
  name: string;
}

/** Every stamp that holds a copy of a stream in the answer, each once, by name. */
export function stampsHoldingCopies(streams: readonly ArchivedStream[]): ArchiveStampChoice[] {
  const named = new Map<string, string>();
  for (const stream of streams) {
    for (const quality of stream.qualities) {
      for (const copy of quality.copies) {
        const batchId = bareBatchId(copy.batchId);
        if (copy.batchLabel !== null || !named.has(batchId)) named.set(batchId, copy.batchLabel ?? shortHex(batchId));
      }
    }
  }
  return [...named]
    .map(([batchId, name]) => ({ batchId, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.batchId.localeCompare(b.batchId));
}

/**
 * The streams that have a copy on the stamp, each with only its qualities that have one there and only those copies,
 * and its size as the archived copies on that stamp hold. `ALL_STAMPS` answers the streams as they are.
 */
export function streamsOnStamp(streams: readonly ArchivedStream[], batchId: string): ArchivedStream[] {
  if (batchId === ALL_STAMPS) return [...streams];
  const on = (copy: ArchiveCopy) => bareBatchId(copy.batchId) === batchId;
  const shown: ArchivedStream[] = [];
  for (const stream of streams) {
    const qualities = stream.qualities
      .filter((quality) => quality.copies.some(on))
      .map((quality) => ({ ...quality, copies: quality.copies.filter(on) }));
    if (qualities.length === 0) continue;
    const bytes = qualities
      .flatMap((quality) => quality.copies)
      .filter((copy) => isArchived(copy.state))
      .reduce((sum, copy) => sum + copy.bytes, 0);
    shown.push({ ...stream, qualities, bytes });
  }
  return shown;
}

type Quality = ArchivedStream['qualities'][number];

/**
 * One copy of a quality: the quality's label and the copy's state, the parity chunks it lost when protection is
 * reduced, and why a stamp no longer listed matters.
 */
function CopyStateLine({ quality, copy }: { quality: Quality; copy: ArchiveCopy }) {
  const lost =
    copy.state === 'reduced' && copy.parityMissing > 0
      ? `, ${copy.parityMissing.toLocaleString('en-US')} parity chunks missing`
      : '';
  const warn =
    copy.state === 'partial' || copy.state === 'reduced' || copy.state === 'unlisted' || copy.state === 'outdated';
  const line = (
    <Typography
      variant="body2"
      noWrap
      sx={{ color: copy.state === 'expired' ? 'error.main' : warn ? 'warning.main' : 'text.primary' }}
    >
      {`${quality.label}: ${QUALITY_STATE_TEXT[copy.state]}${lost}`}
    </Typography>
  );
  if (copy.state !== 'unlisted') return line;
  return (
    <Box>
      {line}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', maxWidth: 360 }}>
        {ARCHIVE_UNLISTED_TEXT}
      </Typography>
    </Box>
  );
}

/** The stamp a copy is on: its label, or its short id, with its time left, in amber when it runs low. */
function StampLine({ copy, stamp }: { copy: ArchiveCopy; stamp: ArchiveStamp | undefined }) {
  const name = copy.batchLabel ?? shortHex(copy.batchId);
  const ttl = copy.batchTtlSeconds ?? stamp?.ttlSeconds ?? null;
  const low = stamp?.expiresSoon ?? false;
  return (
    <Typography variant="body2" noWrap title={copy.batchId}>
      {name}
      <Box component="span" sx={{ color: low ? 'warning.main' : 'text.secondary' }}>
        {` · ${ttl === 0 ? 'expired' : `${formatTimeLeft(ttl)} left`}`}
      </Box>
    </Typography>
  );
}

/** Every copy of a stream's qualities, quality by quality, each quality's in the order of `orderArchiveCopies`. */
function copiesOf(stream: ArchivedStream): Array<{ quality: Quality; copy: ArchiveCopy }> {
  return stream.qualities.flatMap((quality) => orderArchiveCopies(quality.copies).map((copy) => ({ quality, copy })));
}

/**
 * The Archive page's content: a stamp filter, then a row per stream that has an archive, newest copy first, with its
 * title, its badge and how its image stands, its date, every copy of each quality with its state, the size of what is
 * archived, the stamp each copy is on with its time left, and when and by whom its newest copy was completed.
 *
 * The filter offers the stamps that hold a copy, from the answer, with "All stamps" first. A stamp chosen lists the
 * streams that have a copy on it, with those copies alone, and the size the archived ones hold.
 *
 * `onArchive`, when given, opens the archive panel on the stream: "Archive more qualities" with nothing ticked,
 * "Archive again" with its outdated qualities ticked. `onCopy`, when given, offers "Copy onto another stamp" on a
 * stream with an archived quality, with its archived qualities. Nothing is ever removed from a stamp, so there is no
 * un-archive.
 */
export function ArchivePageView({
  streams,
  stamps,
  onArchive,
  onCopy,
}: {
  streams: readonly ArchivedStream[];
  /** The archive stamps as the admin read them, by `bareBatchId`, for their time left and their warning. */
  stamps: ReadonlyMap<string, ArchiveStamp>;
  onArchive?: (streamId: string, preselect?: readonly string[]) => void;
  onCopy?: (streamId: string, renditions: readonly string[]) => void;
}) {
  const [stampFilter, setStampFilter] = useState(ALL_STAMPS);
  const choices = useMemo(() => stampsHoldingCopies(streams), [streams]);
  // A stamp that holds no copy any more, after a refresh, lists every stream again.
  const filter = choices.some((choice) => choice.batchId === stampFilter) ? stampFilter : ALL_STAMPS;
  const shown = useMemo(() => streamsOnStamp(streams, filter), [streams, filter]);
  const actions = onArchive !== undefined || onCopy !== undefined;

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
    <Stack spacing={2}>
      <Box>
        <TextField
          id="archive-stamp-filter"
          label="Stamp"
          select
          size="small"
          value={filter}
          onChange={(event) => setStampFilter(event.target.value)}
          sx={{ minWidth: 220, maxWidth: '100%' }}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
        >
          <option value={ALL_STAMPS}>All stamps</option>
          {choices.map((choice) => (
            <option key={choice.batchId} value={choice.batchId}>
              {choice.name}
            </option>
          ))}
        </TextField>
      </Box>
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
              {actions ? <TableCell align="right">Actions</TableCell> : null}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((stream) => {
              const outdated = outdatedQualities(stream);
              const archived = archivedQualities(stream);
              const copies = copiesOf(stream);
              const thumbnail = ARCHIVE_THUMBNAIL_TEXT[stream.thumbnail.state];
              return (
                <TableRow key={stream.streamId} hover sx={{ verticalAlign: 'top' }}>
                  <TableCell sx={{ minWidth: 180, maxWidth: 320 }}>
                    <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                      <Link component={RouterLink} to={`/streams/${stream.streamId}`} sx={{ overflowWrap: 'anywhere' }}>
                        {stream.title}
                      </Link>
                      <ArchiveBadge archive={stream.summary} />
                      {thumbnail ? (
                        <Typography
                          variant="caption"
                          sx={{ color: stream.thumbnail.state === 'archived' ? 'text.secondary' : 'warning.main' }}
                        >
                          {thumbnail}
                        </Typography>
                      ) : null}
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{stream.date ?? '—'}</TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      {copies.map(({ quality, copy }) => (
                        <CopyStateLine key={`${quality.rendition}:${copy.batchId}`} quality={quality} copy={copy} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {formatCapacity(stream.bytes)}
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      {copies.map(({ quality, copy }) => (
                        <StampLine
                          key={`${quality.rendition}:${copy.batchId}`}
                          copy={copy}
                          stamp={stamps.get(bareBatchId(copy.batchId))}
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
                  {actions ? (
                    <TableCell align="right">
                      <Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
                        {onArchive && outdated.length > 0 ? (
                          <Button size="small" variant="outlined" onClick={() => onArchive(stream.streamId, outdated)}>
                            Archive again
                          </Button>
                        ) : null}
                        {onArchive ? (
                          <Button size="small" onClick={() => onArchive(stream.streamId)} sx={{ whiteSpace: 'nowrap' }}>
                            Archive more qualities
                          </Button>
                        ) : null}
                        {onCopy && archived.length > 0 ? (
                          <Button
                            size="small"
                            onClick={() => onCopy(stream.streamId, archived)}
                            sx={{ whiteSpace: 'nowrap' }}
                          >
                            Copy onto another stamp
                          </Button>
                        ) : null}
                      </Stack>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

/**
 * The Archive page, `/archive`: only the streams that have an archive, read from `GET /api/archive/streams`, with the
 * archive stamps from `GET /api/archive/stamps` for their warning. Stamps that could not be read leave the rows
 * without the warning, nothing else. `onArchive` opens the archive panel and `onCopy` opens it for a further copy;
 * with neither, the page offers no action.
 */
export function ArchivePage({
  onArchive,
  onCopy,
}: {
  onArchive?: (streamId: string, preselect?: readonly string[]) => void;
  onCopy?: (streamId: string, renditions: readonly string[]) => void;
}) {
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
      {streams ? <ArchivePageView streams={streams} stamps={stamps} onArchive={onArchive} onCopy={onCopy} /> : null}
    </Stack>
  );
}
