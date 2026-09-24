import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
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
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { formatDuration, shortHex } from '../format';
import { IngestPanel } from '../components/IngestPanel';
import { MEDIA_TYPE_LABEL, StatusChip } from '../components/StatusChip';
import { useSnackbar } from '../components/Snackbar';
import { CopyButton } from '../components/CopyButton';

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      <Box sx={{ mt: 0.25 }}>{children}</Box>
    </Box>
  );
}

function Mono({ value, label }: { value: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
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
    api.fetchPublicConfig().then(setConfig).catch(() => undefined);
  }, [id, snackbar]);

  useEffect(() => {
    // A different stream means everything on screen is stale, the OBS panel
    // included.
    setStream(null);
    setIngest(null);
    setLastResult(null);
    load();
  }, [load]);

  const runPublish = async (action: 'publish' | 'unpublish') => {
    if (!id) return;
    setBusy(true);
    try {
      const result =
        action === 'publish'
          ? await api.publishStream(id)
          : await api.unpublishStream(id);
      setStream(result.stream);
      setLastResult(result);
      snackbar.success(
        action === 'publish'
          ? `Published at feed index ${result.feed.index}.`
          : `Unpublished. Feed is at index ${result.feed.index}.`,
      );
    } catch (e) {
      snackbar.error(
        errorMessage(
          e,
          action === 'publish' ? 'Publish failed' : 'Unpublish failed',
        ),
      );
      // The backend records publish_error on the row; re-read it so the page
      // shows what it stored rather than only the transient snackbar.
      if (id) api.fetchStream(id).then(setStream).catch(() => undefined);
    } finally {
      setBusy(false);
    }
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
  const canPublish = stream.status !== 'publishing';
  // `publishing` keeps saying Publish: a first publish is in flight, and the
  // button is disabled anyway.
  const publishLabel =
    stream.status === 'draft' || stream.status === 'publishing'
      ? 'Publish'
      : 'Republish';
  const canUnpublish =
    stream.status === 'published' || stream.status === 'vod';
  const viewerBaseUrl = config?.viewerBaseUrl ?? null;

  return (
    // The same column width as the form the operator arrived from, so the two
    // screens do not jump about between each other.
    <Stack spacing={3} sx={{ width: '100%', maxWidth: 760, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap">
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
          <IconButton
            size="small"
            aria-label="refresh stream"
            onClick={load}
            disabled={busy}
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Button
          size="small"
          startIcon={<EditIcon />}
          component={RouterLink}
          to={`/edit/${stream.id}`}
        >
          Edit
        </Button>
        <Button size="small" onClick={() => navigate('/')}>
          Back to My Streams
        </Button>
      </Stack>

      {stream.publishError ? (
        <Alert severity="error">
          Last publish attempt failed: {stream.publishError}
        </Alert>
      ) : null}

      {/*
        An edit to a stream on the catalogue writes no feed entry, so the entry
        stays behind until the operator republishes, and nothing else on the
        page would say so. The API decides it, because only the API knows which
        edit the entry was last rebuilt from.
      */}
      {stream.hasUnpublishedEdits ? (
        <Alert severity="warning">
          Edited since it was published. Republish to update the feed.
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Grid container spacing={3}>
          <Grid item xs={12} sm={4} md={3}>
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
          <Grid item xs={12} sm={8} md={9}>
            <Stack spacing={2}>
              <Field label="Description">
                <Typography variant="body2">{stream.description}</Typography>
              </Field>
              <Field label="Tags">
                {stream.tags.length ? (
                  <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                    {stream.tags.map((tag) => (
                      <Chip key={tag} size="small" label={tag} />
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    —
                  </Typography>
                )}
              </Field>
              <Grid container spacing={2}>
                <Grid item xs={6} sm={4}>
                  <Field label="Media type">
                    <Typography variant="body2">
                      {MEDIA_TYPE_LABEL[stream.mediaType]}
                    </Typography>
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Scheduled start">
                    <Typography variant="body2">
                      {formatDateTime(stream.scheduledStartTime)}
                    </Typography>
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Published">
                    <Typography variant="body2">
                      {formatDateTime(stream.publishedAt)}
                    </Typography>
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Feed owner">
                    <Mono value={stream.owner} label="Feed owner" />
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Topic">
                    <Mono value={stream.topic} label="Topic" />
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Feed index">
                    <Typography variant="body2">
                      {stream.publishedFeedIndex ?? '—'}
                    </Typography>
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Thumbnail reference">
                    {stream.thumbnailRef ? (
                      <Mono
                        value={stream.thumbnailRef}
                        label="Thumbnail reference"
                      />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )}
                  </Field>
                </Grid>
                {stream.liveSince ? (
                  <Grid item xs={6} sm={4}>
                    <Field label="Live since">
                      <Typography variant="body2">
                        {formatDateTime(stream.liveSince)}
                      </Typography>
                    </Field>
                  </Grid>
                ) : null}
                {stream.endedAt ? (
                  <Grid item xs={6} sm={4}>
                    <Field label="Ended">
                      <Typography variant="body2">
                        {formatDateTime(stream.endedAt)}
                      </Typography>
                    </Field>
                  </Grid>
                ) : null}
                {stream.durationSeconds != null ? (
                  <Grid item xs={6} sm={4}>
                    <Field label="Duration">
                      <Typography variant="body2">
                        {formatDuration(stream.durationSeconds)}
                      </Typography>
                    </Field>
                  </Grid>
                ) : null}
                {stream.manifestIndex != null ? (
                  <Grid item xs={6} sm={4}>
                    <Field label="Manifest index">
                      <Typography variant="body2">
                        {stream.manifestIndex}
                      </Typography>
                    </Field>
                  </Grid>
                ) : null}
                <Grid item xs={6} sm={4}>
                  <Field label="Created">
                    <Typography variant="body2">
                      {formatDateTime(stream.createdAt)}
                    </Typography>
                  </Field>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Field label="Updated">
                    <Typography variant="body2">
                      {formatDateTime(stream.updatedAt)}
                    </Typography>
                  </Field>
                </Grid>
              </Grid>
            </Stack>
          </Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
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
            onClick={() => void runPublish('unpublish')}
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

        <Stack
          direction="row"
          spacing={0.5}
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
          sx={{ mt: 1 }}
        >
          <Typography variant="caption" color="text.secondary">
            Direct stream route, once the stream has gone live:
          </Typography>
          <Typography
            variant="caption"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
          >
            {watchPath(stream)}
          </Typography>
          <CopyButton value={watchPath(stream)} label="stream route" />
        </Stack>

        {lastResult ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            Feed index {lastResult.feed.index} · {lastResult.feed.entryCount}{' '}
            {lastResult.feed.entryCount === 1 ? 'entry' : 'entries'} · owner{' '}
            {shortHex(lastResult.feed.owner, 10, 8)} · topic{' '}
            {lastResult.feed.topic}
          </Alert>
        ) : null}
      </Paper>

      {ingest ? (
        <IngestPanel
          streamId={stream.id}
          details={ingest}
          onRotated={setIngest}
        />
      ) : null}
    </Stack>
  );
}
