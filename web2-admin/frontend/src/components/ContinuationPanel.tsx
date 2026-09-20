import { useEffect, useRef, useState } from 'react';
import { Alert, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import type {
  ContinuationCreateRequest,
  OwnerContinuationOperation,
  Stream,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDuration } from '../format';
import { ApiError } from '../http';
import { useSnackbar } from './Snackbar';

const ACTIVE_OPERATION = new Set<OwnerContinuationOperation['status']>([
  'pending',
  'ready',
]);

const STATUS_LABEL: Record<OwnerContinuationOperation['status'], string> = {
  pending: 'Preparing continuation',
  ready: 'Ready for OBS',
  failed: 'Preparation failed',
  cancelled: 'Continuation cancelled',
  claimed: 'Continuation claimed',
};

const ACTIVE_REPORT_STATES = new Set(['claimed', 'live', 'waiting']);
const REPORT_STALE_AFTER_MS = 30_000;

const LIFECYCLE_LABEL = {
  ready: 'Ready for OBS',
  claimed: 'Starting broadcast',
  live: 'Live',
  waiting: 'Waiting for reconnection',
  closed: 'Finishing recording',
  vod: 'Recording ready',
} as const;

function lifecycleStatus(stream: Stream, stale: boolean): string {
  const lifecycle = stream.lifecycle;
  if (!lifecycle) return '';
  return `Run ${lifecycle.runNumber}: ${
    stale ? 'Status unavailable' : LIFECYCLE_LABEL[lifecycle.state]
  }`;
}

function canContinue(stream: Stream): boolean {
  return (
    stream.lifecycle?.permission === 'closed' &&
    (stream.lifecycle.state === 'closed' || stream.lifecycle.state === 'vod')
  );
}

function isExplainedFailure(error: unknown): boolean {
  return error instanceof ApiError;
}

export function ContinuationPanel({
  stream,
  reload,
}: {
  stream: Stream;
  reload: () => void;
}) {
  const snackbar = useSnackbar();
  const retryRequest = useRef<ContinuationCreateRequest | null>(null);
  const [operation, setOperation] = useState<OwnerContinuationOperation | null>(
    stream.continuation ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const incoming = stream.continuation;
    setOperation((current) => {
      if (incoming) {
        return !current || incoming.revision >= current.revision
          ? incoming
          : current;
      }
      return current &&
        stream.lifecycle &&
        stream.lifecycle.revision >= current.revision
        ? null
        : current;
    });
  }, [stream.continuation, stream.lifecycle]);

  useEffect(() => {
    if (
      conflictRevision !== null &&
      ((stream.lifecycle?.revision ?? -1) > conflictRevision ||
        stream.continuation)
    ) {
      setConflictRevision(null);
    }
  }, [conflictRevision, stream.continuation, stream.lifecycle?.revision]);

  useEffect(() => {
    const lifecycle = stream.lifecycle;
    if (!lifecycle || !ACTIVE_REPORT_STATES.has(lifecycle.state)) {
      setStale(false);
      return;
    }
    const age = lifecycle.observationAgeMs;
    if (age === undefined || age >= REPORT_STALE_AFTER_MS) {
      setStale(true);
      return;
    }
    setStale(false);
    const timer = window.setTimeout(
      () => setStale(true),
      REPORT_STALE_AFTER_MS - age,
    );
    return () => window.clearTimeout(timer);
  }, [
    stream.lifecycle?.observationAgeMs,
    stream.lifecycle?.revision,
    stream.lifecycle?.state,
  ]);

  const lifecycle = stream.lifecycle;
  if (!lifecycle) return null;

  const conflicted = conflictRevision !== null;
  const active = operation && ACTIVE_OPERATION.has(operation.status);
  const continueAvailable = canContinue(stream) && !active && !conflicted;

  const start = async () => {
    const request = retryRequest.current ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: lifecycle.revision,
    };
    retryRequest.current = request;
    setBusy(true);
    setConflictRevision(null);
    try {
      let created: OwnerContinuationOperation;
      try {
        created = await api.createContinuation(stream.id, request);
      } catch (error) {
        if (isExplainedFailure(error)) throw error;
        created = await api.createContinuation(stream.id, request);
      }
      retryRequest.current = null;
      setOperation((current) =>
        !current || created.revision >= current.revision ? created : current,
      );
      reload();
      snackbar.success('Continuation preparation started.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        retryRequest.current = null;
        setConflictRevision(lifecycle.revision);
        reload();
      }
      snackbar.error(errorMessage(error, 'Could not continue this stream'));
    } finally {
      setBusy(false);
    }
  };

  const refreshOperation = async () => {
    if (!operation) return;
    setBusy(true);
    try {
      const refreshed = await api.fetchContinuation(
        stream.id,
        operation.operationId,
      );
      setOperation((current) =>
        !current || refreshed.revision >= current.revision ? refreshed : current,
      );
      reload();
    } catch (error) {
      snackbar.error(errorMessage(error, 'Could not refresh the continuation'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!operation || !ACTIVE_OPERATION.has(operation.status)) return;
    setBusy(true);
    try {
      const cancelled = await api.cancelContinuation(
        stream.id,
        operation.operationId,
      );
      setOperation((current) =>
        !current || cancelled.revision >= current.revision ? cancelled : current,
      );
      reload();
      snackbar.success('Continuation cancelled.');
    } catch (error) {
      snackbar.error(errorMessage(error, 'Could not cancel the continuation'));
      await refreshOperation();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Continuation</Typography>
        <Typography variant="body2">
          {lifecycleStatus(stream, stale)}
        </Typography>
        {stream.completedRecording ? (
          <Typography variant="body2">
            Previous replay: run {stream.completedRecording.runNumber},{' '}
            {formatDuration(stream.completedRecording.master.duration)}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No completed replay is available yet.
          </Typography>
        )}
        {conflicted ? (
          <Alert severity="warning">
            Another tab changed this stream. Refresh before trying again.
          </Alert>
        ) : null}
        {operation ? (
          <Alert severity={operation.status === 'failed' ? 'error' : 'info'}>
            {STATUS_LABEL[operation.status]}. Run {operation.nextRunNumber}.
            {operation.failure ? ` ${operation.failure}` : ''}
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} alignItems="center">
          {continueAvailable ? (
            <Button variant="contained" onClick={() => void start()} disabled={busy}>
              Continue stream
            </Button>
          ) : null}
          {operation ? (
            <Button onClick={() => void refreshOperation()} disabled={busy}>
              Refresh continuation
            </Button>
          ) : null}
          {active ? (
            <Button color="warning" onClick={() => void cancel()} disabled={busy}>
              Cancel continuation
            </Button>
          ) : null}
          {busy ? <CircularProgress size={20} /> : null}
        </Stack>
        {continueAvailable ? (
          <Typography variant="caption" color="text.secondary">
            Preparation keeps this run closed. OBS may keep retrying and is admitted
            only after the uploader reports Ready for OBS.
          </Typography>
        ) : null}
      </Stack>
    </Paper>
  );
}
