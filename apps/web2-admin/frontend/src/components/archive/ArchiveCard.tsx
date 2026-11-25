import {
  ARCHIVE_THUMBNAIL_TEXT,
  ARCHIVE_UNLISTED_TEXT,
  holdsFinishedRecording,
  isArchived,
  orderArchiveCopies,
  type ArchiveCopy,
  type ArchiveOptionsResponse,
  type ArchiveQuality,
  type ArchiveStamp,
  type Stream,
} from '@streaming-monorepo/web2-admin-common';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import { fetchArchiveOptions, setArchiveListing } from '../../api';
import { errorMessage } from '../../errors';
import { formatTimeLeft, shortHex } from '../../format';
import { useSnackbar } from '../Snackbar';
import { formatBytes, formatUtc } from '../export/exportText';
import {
  archiveWidgetLine,
  estimateLine,
  estimateOf,
  formatCount,
  QUALITY_STATE_COLOR,
  qualityStateText,
} from './archiveJobText';
import { useArchive } from './ArchiveProvider';

/** Said under the "List only archived qualities" switch. */
export const LISTING_HELP =
  'On, the catalogue lists only the qualities that play from an archive stamp, and the players offer no other. ' +
  'Turning it on or off writes the catalogue entry again.';

/** The start action's words: again once a copy is outdated, more once a quality is archived, the recording before. */
export function startLabel(qualities: readonly ArchiveQuality[]): string {
  if (qualities.some((quality) => quality.state === 'outdated')) return 'Archive again';
  if (qualities.some((quality) => isArchived(quality.state))) return 'Archive more qualities';
  return 'Archive this recording';
}

/** What a copy's line is told from: a copy, or a quality's own fields, which are its best copy's. */
type CopyFacts = Pick<ArchiveCopy, 'state' | 'batchLabel' | 'parityMissing' | 'completedAt' | 'completedBy'> & {
  batchId: string | null;
  bytes: number | null;
};

/** What one copy holds and where, as a sentence that starts in lower case, with what a lesser copy lacks. */
function copyFacts(copy: CopyFacts): string {
  const where = copy.batchLabel
    ? `“${copy.batchLabel}”`
    : copy.batchId
      ? `the stamp ${shortHex(copy.batchId)}`
      : 'an archive stamp';
  const size = copy.bytes !== null ? `${formatBytes(copy.bytes)} ` : '';
  const done = copy.completedAt
    ? `, completed ${formatUtc(copy.completedAt)}${copy.completedBy ? ` by ${copy.completedBy}` : ''}`
    : '';
  let line = `${size}on ${where}${done}.`;
  if (copy.state === 'partial') line = `${size}copied onto ${where} before the copy stopped.`;
  if (copy.state === 'reduced') {
    line += ` ${formatCount(copy.parityMissing)} parity chunk${copy.parityMissing === 1 ? '' : 's'} could not be read, so it plays with less protection.`;
  }
  if (copy.state === 'unlisted') line += ` ${ARCHIVE_UNLISTED_TEXT}`;
  if (copy.state === 'outdated') line += ' The stream recorded again after the copy.';
  if (copy.state === 'expired') line += ' The stamp has expired.';
  return line;
}

/**
 * Where one quality's best copy stands: `2.2 GB on “Talks”, completed 2026-11-12 09:51:10 UTC by alice`, with what a
 * reduced, unlisted, outdated or expired copy lacks; or, with no copy, its estimate or why it cannot be archived.
 */
export function copyLine(quality: ArchiveQuality): string {
  if (quality.state === 'none') return quality.unavailable ?? estimateLine(estimateOf([quality]));
  const line = copyFacts({ ...quality, state: quality.state });
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * One copy of a quality, as the Archive page lists it: its state, what it holds on which stamp, and that stamp's time
 * left: `Archived: 2.2 GB on “Talks”, completed 2026-11-12 09:51:10 UTC by alice. 200 days left on the stamp.`
 */
export function copyOnStampLine(copy: ArchiveCopy): string {
  const ttl = copy.batchTtlSeconds;
  const left = ttl !== null && ttl > 0 ? ` ${formatTimeLeft(ttl)} left on the stamp.` : '';
  return `${qualityStateText(copy.state)}: ${copyFacts(copy)}${left}`;
}

/** Whether a stamp has run out: read expired or gone, or its time left gone by since the reading. */
function ranOut(stamp: ArchiveStamp): boolean {
  return stamp.state === 'expired' || stamp.state === 'gone' || stamp.ttlSeconds === 0;
}

/**
 * The stamps holding a copy of this stream that run out soon, each once, whatever else their state: full, or left on
 * a node that is the catalogue node no longer. One that has run out already is not among them: its copies say so.
 */
function stampsRunningOut(options: ArchiveOptionsResponse): ArchiveStamp[] {
  return options.holdingStamps.filter((stamp) => stamp.expiresSoon && !ranOut(stamp));
}

/**
 * The warning for a stamp that runs out soon: its time left, and where it is topped up, on the Funding page's Stamps
 * tab or, for a stamp left on a node that is the catalogue node no longer (read, and not written), outside the admin.
 */
function runningOutText(stamp: ArchiveStamp): string {
  const left = !stamp.writable && (stamp.state === 'active' || stamp.state === 'full');
  const where = left
    ? 'Its node is the catalogue node no longer, so the admin does not top it up, and what it holds goes when it expires unless it is topped up outside the admin.'
    : "Top it up on the Funding page's Stamps tab, or what it holds goes when it expires.";
  return `“${stamp.label ?? shortHex(stamp.batchId)}” has ${formatTimeLeft(stamp.ttlSeconds)} left. ${where}`;
}

/**
 * On a stream's page: its archive, quality by quality, each with its copies in the order of `orderArchiveCopies`, how
 * the stream's image stands, the action that starts one, and the "List only archived qualities" switch once a quality
 * plays from an archive stamp. Shown for a stream that holds a finished recording or
 * has a copy. It reads the stream's archive again whenever the archive of this stream changes state.
 */
export function ArchiveCard({ stream, onChanged }: { stream: Stream; onChanged?: () => void }) {
  const { current, openPanel } = useArchive();
  const snackbar = useSnackbar();
  const [options, setOptions] = useState<ArchiveOptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const shown = holdsFinishedRecording(stream) || stream.archive !== undefined;
  const job = current !== null && current.streamId === stream.id ? current : null;
  const jobKey = job ? `${job.id}:${job.state}` : null;

  const load = useCallback(() => {
    let stale = false;
    setError(null);
    fetchArchiveOptions(stream.id).then(
      (answer) => {
        if (!stale) setOptions(answer);
      },
      (failure: unknown) => {
        if (!stale) setError(errorMessage(failure, "The stream's archive could not be read."));
      },
    );
    return () => {
      stale = true;
    };
  }, [stream.id]);

  useEffect(() => {
    if (!shown) return;
    return load();
  }, [shown, load, jobKey]);

  if (!shown) return null;

  const flip = async (archivedOnly: boolean) => {
    setSwitching(true);
    try {
      setOptions(await setArchiveListing(stream.id, archivedOnly));
      snackbar.success(`List only archived qualities is ${archivedOnly ? 'on' : 'off'}.`);
      onChanged?.();
    } catch (failure) {
      snackbar.error(errorMessage(failure, 'The switch could not be changed.'));
    } finally {
      setSwitching(false);
    }
  };

  const unfinished = job !== null && job.state !== 'done' ? job : null;

  return (
    <Paper sx={{ p: 3 }} component="section" aria-label="archive">
      <Typography variant="h6" component="h2" gutterBottom>
        Archive
      </Typography>
      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => load()}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}
      {!options && !error ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} aria-label="reading the archive" />
        </Box>
      ) : null}
      {options ? (
        <Stack spacing={2}>
          {unfinished ? (
            <Alert
              severity="info"
              action={
                <Button color="inherit" size="small" onClick={() => openPanel(null)}>
                  Open the archive
                </Button>
              }
            >
              An archive of this stream is under way: {archiveWidgetLine(unfinished)}.
            </Alert>
          ) : null}
          <Stack spacing={1.5} aria-label="qualities">
            {options.qualities.map((quality) => (
              <Box key={quality.rendition}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography>
                    {quality.label}
                    {quality.width && quality.height ? ` · ${quality.width}×${quality.height}` : ''}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={QUALITY_STATE_COLOR[quality.state]}
                    label={qualityStateText(quality.state)}
                  />
                </Stack>
                {quality.copies.length > 0 ? (
                  orderArchiveCopies(quality.copies).map((copy) => (
                    <Typography
                      key={copy.batchId}
                      variant="body2"
                      sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}
                    >
                      {copyOnStampLine(copy)}
                    </Typography>
                  ))
                ) : (
                  <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
                    {copyLine(quality)}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
          {ARCHIVE_THUMBNAIL_TEXT[options.thumbnail.state] ? (
            <Typography
              variant="body2"
              sx={{ color: options.thumbnail.state === 'archived' ? 'text.secondary' : 'warning.main' }}
            >
              {ARCHIVE_THUMBNAIL_TEXT[options.thumbnail.state]}
            </Typography>
          ) : null}
          {stampsRunningOut(options).map((stamp) => (
            <Alert key={stamp.batchId} severity="warning">
              {runningOutText(stamp)}
            </Alert>
          ))}
          {holdsFinishedRecording(stream) ? (
            <Box>
              <Button variant="outlined" onClick={() => openPanel(stream.id)}>
                {startLabel(options.qualities)}
              </Button>
            </Box>
          ) : null}
          {options.canListArchivedOnly || options.summary.archivedOnly ? (
            <Box>
              <FormControlLabel
                control={
                  <Switch
                    checked={options.summary.archivedOnly}
                    disabled={switching}
                    onChange={(event) => void flip(event.target.checked)}
                  />
                }
                label="List only archived qualities"
              />
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {LISTING_HELP}
              </Typography>
              {options.archivedOnlyHint && !options.summary.archivedOnly ? (
                <Alert severity="info" sx={{ mt: 1 }}>
                  {options.archivedOnlyHint}
                </Alert>
              ) : null}
            </Box>
          ) : null}
        </Stack>
      ) : null}
    </Paper>
  );
}
