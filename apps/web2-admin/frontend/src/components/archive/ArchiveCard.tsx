import {
  holdsFinishedRecording,
  isArchived,
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

/**
 * Where one quality's copy stands: `2.2 GB on “Talks”, completed 2026-11-12 09:51:10 UTC by alice`, with what a
 * reduced, outdated or expired copy lacks; or, with no copy, its estimate or why it cannot be archived.
 */
export function copyLine(quality: ArchiveQuality): string {
  if (quality.state === 'none') return quality.unavailable ?? estimateLine(estimateOf([quality]));
  const where = quality.batchLabel
    ? `“${quality.batchLabel}”`
    : quality.batchId
      ? `the stamp ${shortHex(quality.batchId)}`
      : 'an archive stamp';
  const size = quality.bytes !== null ? `${formatBytes(quality.bytes)} ` : '';
  const done = quality.completedAt
    ? `, completed ${formatUtc(quality.completedAt)}${quality.completedBy ? ` by ${quality.completedBy}` : ''}`
    : '';
  let line = `${size}on ${where}${done}.`;
  if (quality.state === 'partial') line = `${size}copied onto ${where} before the copy stopped.`;
  if (quality.state === 'reduced') {
    line += ` ${formatCount(quality.parityMissing)} parity chunk${quality.parityMissing === 1 ? '' : 's'} could not be read, so it plays with less protection.`;
  }
  if (quality.state === 'outdated') line += ' The stream recorded again after the copy.';
  if (quality.state === 'expired') line += ' The stamp has expired.';
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The stamps holding a copy of this stream that run out soon, each once. */
function stampsRunningOut(options: ArchiveOptionsResponse): ArchiveStamp[] {
  const held = new Set(options.qualities.map((quality) => quality.batchId).filter((id): id is string => id !== null));
  return options.stamps.filter((stamp) => stamp.expiresSoon && held.has(stamp.batchId));
}

/**
 * On a stream's page: its archive, quality by quality, with the action that starts one, and the "List only archived
 * qualities" switch once a quality plays from an archive stamp. Shown for a stream that holds a finished recording or
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
                <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
                  {copyLine(quality)}
                </Typography>
              </Box>
            ))}
          </Stack>
          {stampsRunningOut(options).map((stamp) => (
            <Alert key={stamp.batchId} severity="warning">
              “{stamp.label ?? shortHex(stamp.batchId)}” has {formatTimeLeft(stamp.ttlSeconds)} left. Top it up on the
              Funding page's Stamps tab, or what it holds goes when it expires.
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
