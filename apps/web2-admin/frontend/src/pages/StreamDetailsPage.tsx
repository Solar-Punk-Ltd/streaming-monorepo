import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  IconButton,
  Link,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import EditIcon from '@mui/icons-material/Edit';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import type {
  IngestDetails,
  PublicConfig,
  PublishResult,
  Stream,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { formatDuration, shortHex } from '../format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IngestPanel } from '../components/IngestPanel';
import { MEDIA_TYPE_LABEL, StatusChip } from '../components/StatusChip';
import { useSnackbar } from '../components/Snackbar';
import { CopyButton } from '../components/CopyButton';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
        {label}
      </Typography>
      <Box sx={{ mt: 0.25 }}>{children}</Box>
    </Box>
  );
}

function Mono({ value, label }: { value: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
        {shortHex(value, 10, 8)}
      </Typography>
      <CopyButton value={value} label={label} />
    </Stack>
  );
}

/**
 * The viewer's root shows the catalogue feed it was built for, which is where
 * a published stream appears. Its per-stream route
 * (`#/watch/<mediatype>/<owner>/<topic>`) needs a manifest feed under that
 * topic, and one only exists once the uploader has written a first segment,
 * so linking a draft straight to it lands on nothing.
 */
function catalogueUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/#/`;
}

function watchPath(stream: Stream): string {
  return `#/watch/${stream.mediaType}/${stream.owner}/${stream.topic}`;
}

/**
 * What an unpublish does, said before it happens. A recording comes off the
 * catalogue and nothing of it is lost: the API keeps where it is, how long it
 * runs and when it was live, and publishing the stream again lists it as that
 * recording.
 */
const UNPUBLISH_PROMPTS = {
  recording: {
    title: 'Unpublish recording',
    message:
      'The recording stops being listed in the catalogue and the stream goes ' +
      'back to a draft. Nothing of the recording is lost: the video stays on ' +
      'Swarm, and this admin keeps where it is, how long it runs and when it ' +
      'was live. Publish it again to list it as this recording.',
  },
  scheduled: {
    title: 'Unpublish stream',
    message:
      'The stream stops being listed in the catalogue and goes back to a ' +
      'draft. Until you publish it again, an encoder cannot go live on it.',
  },
} as const;

/** Beside a Publish that is disabled because the draft has no stage. The API's `stage_required` sentence. */
export const NEEDS_STAGE_HINT = 'Pick the stage this stream is broadcast on before publishing.';

/** Beside a Republish that is disabled because the catalogue entry already carries every edit. */
export const UP_TO_DATE_HINT = 'Nothing to republish: the catalogue already has the latest edit.';

/** The statuses whose stream has an entry on the catalogue, as the API counts them. */
const ON_CATALOGUE: readonly StreamStatus[] = ['published', 'live', 'vod'];

type UnpublishPrompt = (typeof UNPUBLISH_PROMPTS)[keyof typeof UNPUBLISH_PROMPTS];

/**
 * The button offers Unpublish on `published` and `vod` only, and of those only
 * `vod` holds a recording.
 */
function unpublishPromptFor(status: StreamStatus): UnpublishPrompt {
  return status === 'vod' ? UNPUBLISH_PROMPTS.recording : UNPUBLISH_PROMPTS.scheduled;
}

export function StreamDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const snackbar = useSnackbar();

  const [stream, setStream] = useState<Stream | null>(null);
  const [ingest, setIngest] = useState<IngestDetails | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<PublishResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  // Chosen when the dialog opens and kept while it closes, so a successful
  // unpublish, which turns the stream into a draft, cannot swap the wording
  // under the closing dialog.
  const [unpublishPrompt, setUnpublishPrompt] = useState<UnpublishPrompt>(UNPUBLISH_PROMPTS.scheduled);

  // Bumped on every load so a slow response for the previous stream cannot
  // overwrite the current one — showing one stream's ingest key under
  // another's title would be worse than showing nothing.
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!id) return;
    const request = (requestId.current += 1);
    const current = () => requestId.current === request;

    setError(null);
    api
      .fetchStream(id)
      .then((s) => {
        if (current()) setStream(s);
      })
      .catch((e: unknown) => {
        if (current()) setError(errorMessage(e, 'Failed to load the stream'));
      });
    api
      .fetchIngest(id)
      .then((i) => {
        if (current()) setIngest(i);
      })
      .catch((e: unknown) => {
        if (current()) {
          snackbar.error(errorMessage(e, 'Failed to load the ingest details'));
        }
      });
    // The player link is optional: a missing viewer base URL is not an error.
    api
      .fetchPublicConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, [id, snackbar]);

  useEffect(() => {
    // A different stream means everything on screen is stale, the OBS panel
    // included.
    setStream(null);
    setIngest(null);
    setLastResult(null);
    setUnpublishOpen(false);
    load();
  }, [load]);

  /** True when the API accepted it. A failure is reported here, not thrown. */
  const runPublish = async (action: 'publish' | 'unpublish'): Promise<boolean> => {
    if (!id) return false;
    setBusy(true);
    try {
      const result = action === 'publish' ? await api.publishStream(id) : await api.unpublishStream(id);
      setStream(result.stream);
      setLastResult(result);
      snackbar.success(
        action === 'unpublish'
          ? `Unpublished. Feed is at index ${result.feed.index}.`
          : result.written
            ? `Published at feed index ${result.feed.index}.`
            : `Nothing to write: the catalogue already has this edit, at feed index ${result.feed.index}.`,
      );
      return true;
    } catch (e) {
      snackbar.error(errorMessage(e, action === 'publish' ? 'Publish failed' : 'Unpublish failed'));
      // The backend records publish_error on the row; re-read it so the page
      // shows what it stored rather than only the transient snackbar.
      if (id)
        api
          .fetchStream(id)
          .then(setStream)
          .catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const askToUnpublish = (status: StreamStatus) => {
    setUnpublishPrompt(unpublishPromptFor(status));
    setUnpublishOpen(true);
  };

  // Closed on success only, as Delete and Rotate key do: after a failure the
  // operator can try again or cancel.
  const confirmUnpublish = async () => {
    if (await runPublish('unpublish')) setUnpublishOpen(false);
  };

  if (error) {
    return (
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
    );
  }

  if (!stream) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress aria-label="Loading stream" />
      </Box>
    );
  }

  // A live or recorded stream can be republished — that is how an edit made
  // mid-broadcast reaches viewers — and it keeps the state it is in. Only a
  // live one cannot be taken off the feed: nothing here can stop the encoder.
  // A draft goes on the catalogue only once it has a stage; the API refuses
  // it with stage_required otherwise, and the button says so first. A stream
  // on the catalogue has something to republish only while the console holds
  // an edit its entry lacks, or after a failed attempt, which may have left the
  // catalogue behind the row: otherwise the API writes nothing.
  const needsStage = stream.status === 'draft' && stream.stageId === null;
  const upToDate = ON_CATALOGUE.includes(stream.status) && !stream.hasUnpublishedEdits && !stream.publishError;
  const canPublish = stream.status !== 'publishing' && !needsStage && !upToDate;
  // `publishing` keeps saying Publish: a first publish is in flight, and the
  // button is disabled anyway.
  const publishLabel = stream.status === 'draft' || stream.status === 'publishing' ? 'Publish' : 'Republish';
  const canUnpublish = stream.status === 'published' || stream.status === 'vod';
  const viewerBaseUrl = config?.viewerBaseUrl ?? null;

  return (
    // The same column width as the form the operator arrived from, so the two
    // screens do not jump about between each other.
    <Stack spacing={3} sx={{ width: '100%', maxWidth: 760, mx: 'auto' }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          {stream.title}
        </Typography>
        <StatusChip status={stream.status} publishError={stream.publishError} />
        {/*
          While `publishing` both publish buttons are disabled and nothing
          pushes the transition here, so without this the operator is stuck
          looking at a screen that will not change.
        */}
        <Tooltip title="Refresh">
          <IconButton size="small" aria-label="refresh stream" onClick={load} disabled={busy}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Button size="small" startIcon={<EditIcon />} component={RouterLink} to={`/edit/${stream.id}`}>
          Edit
        </Button>
        <Button size="small" onClick={() => navigate('/')}>
          Back to Streams
        </Button>
      </Stack>

      {stream.publishError ? <Alert severity="error">Last publish attempt failed: {stream.publishError}</Alert> : null}

      {/*
        An edit to a stream on the catalogue writes no feed entry, so the entry
        stays behind until the operator republishes, and nothing else on the
        page would say so. The API decides it, because only the API knows which
        edit the entry was last rebuilt from.
      */}
      {stream.hasUnpublishedEdits ? (
        <Alert severity="warning">Edited since it was published. Republish to update the feed.</Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, sm: 4, md: 3 }}>
            {stream.hasThumbnail ? (
              <Box
                component="img"
                src={api.thumbnailUrl(stream)}
                alt={`${stream.title} thumbnail`}
                sx={{
                  width: '100%',
                  aspectRatio: '16 / 9',
                  objectFit: 'cover',
                  borderRadius: 1,
                }}
              />
            ) : (
              <Box
                sx={{
                  width: '100%',
                  aspectRatio: '16 / 9',
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'text.disabled',
                  fontSize: 13,
                }}
              >
                No thumbnail
              </Box>
            )}
          </Grid>
          <Grid size={{ xs: 12, sm: 8, md: 9 }}>
            <Stack spacing={2}>
              <Field label="Description">
                <Typography variant="body2">{stream.description}</Typography>
              </Field>
              <Field label="Tags">
                {stream.tags.length ? (
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    {stream.tags.map((tag) => (
                      <Chip key={tag} size="small" label={tag} />
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    —
                  </Typography>
                )}
              </Field>
              {/*
                The Grid before MUI 7 sat here with its item padding, and the
                Stack's margin reset cancelled the negative margins that
                padding relies on. So these fields stood 16px in from and 16px
                below the ones above. The padding and width keep that layout.
              */}
              <Grid container spacing={2} sx={{ width: 'calc(100% + 16px)', pl: 2, pt: 2 }}>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Media type">
                    <Typography variant="body2">{MEDIA_TYPE_LABEL[stream.mediaType]}</Typography>
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Stage">
                    {/* Named by the OBS details, which are read from the stage. */}
                    <Typography variant="body2">
                      {ingest?.stage ? ingest.stage.name : stream.stageId ? '—' : 'No stage'}
                    </Typography>
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Scheduled start">
                    <Typography variant="body2">{formatDateTime(stream.scheduledStartTime)}</Typography>
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Published">
                    <Typography variant="body2">{formatDateTime(stream.publishedAt)}</Typography>
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Feed owner">
                    <Mono value={stream.owner} label="Feed owner" />
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Topic">
                    <Mono value={stream.topic} label="Topic" />
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Feed index">
                    <Typography variant="body2">{stream.publishedFeedIndex ?? '—'}</Typography>
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Thumbnail reference">
                    {stream.thumbnailRef ? (
                      <Mono value={stream.thumbnailRef} label="Thumbnail reference" />
                    ) : (
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        —
                      </Typography>
                    )}
                  </Field>
                </Grid>
                {stream.liveSince ? (
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Field label="Live since">
                      <Typography variant="body2">{formatDateTime(stream.liveSince)}</Typography>
                    </Field>
                  </Grid>
                ) : null}
                {stream.endedAt ? (
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Field label="Ended">
                      <Typography variant="body2">{formatDateTime(stream.endedAt)}</Typography>
                    </Field>
                  </Grid>
                ) : null}
                {stream.durationSeconds != null ? (
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Field label="Duration">
                      <Typography variant="body2">{formatDuration(stream.durationSeconds)}</Typography>
                    </Field>
                  </Grid>
                ) : null}
                {stream.manifestIndex != null ? (
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Field label="Manifest index">
                      <Typography variant="body2">{stream.manifestIndex}</Typography>
                    </Field>
                  </Grid>
                ) : null}
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Created">
                    <Typography variant="body2">{formatDateTime(stream.createdAt)}</Typography>
                  </Field>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Field label="Updated">
                    <Typography variant="body2">{formatDateTime(stream.updatedAt)}</Typography>
                  </Field>
                </Grid>
              </Grid>
            </Stack>
          </Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            startIcon={<CloudUploadIcon />}
            disabled={busy || !canPublish}
            onClick={() => void runPublish('publish')}
          >
            {publishLabel}
          </Button>
          <Button
            startIcon={<CloudOffIcon />}
            color="warning"
            disabled={busy || !canUnpublish}
            onClick={() => askToUnpublish(stream.status)}
          >
            Unpublish
          </Button>
          {busy ? <CircularProgress size={20} /> : null}
          {viewerBaseUrl ? (
            <Link
              href={catalogueUrl(viewerBaseUrl)}
              target="_blank"
              rel="noreferrer"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
            >
              Open player catalogue <OpenInNewIcon fontSize="inherit" />
            </Link>
          ) : null}
        </Stack>
        {needsStage ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
            {NEEDS_STAGE_HINT}{' '}
            <Link component={RouterLink} to={`/edit/${stream.id}`}>
              Edit the stream
            </Link>
          </Typography>
        ) : null}
        {upToDate ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
            {UP_TO_DATE_HINT}
          </Typography>
        ) : null}

        <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Direct stream route, once the stream has gone live:
          </Typography>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {watchPath(stream)}
          </Typography>
          <CopyButton value={watchPath(stream)} label="stream route" />
        </Stack>

        {lastResult ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            Feed index {lastResult.feed.index} · {lastResult.feed.entryCount}{' '}
            {lastResult.feed.entryCount === 1 ? 'entry' : 'entries'} · owner {shortHex(lastResult.feed.owner, 10, 8)} ·
            topic {lastResult.feed.topic}
          </Alert>
        ) : null}
      </Paper>

      {ingest ? <IngestPanel streamId={stream.id} details={ingest} onRotated={setIngest} /> : null}

      <ConfirmDialog
        open={unpublishOpen}
        title={unpublishPrompt.title}
        message={unpublishPrompt.message}
        confirmText={busy ? 'Unpublishing…' : 'Unpublish'}
        busy={busy}
        onConfirm={() => void confirmUnpublish()}
        onCancel={() => setUnpublishOpen(false)}
      />
    </Stack>
  );
}
