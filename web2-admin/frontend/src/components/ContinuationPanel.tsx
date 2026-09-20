import { useRef, useState } from 'react';
import { Alert, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import type {
  ContinuationCreateRequest,
  OwnerContinuationOperation,
  Stream,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
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

function lifecycleStatus(stream: Stream): string {
  const lifecycle = stream.lifecycle;
  if (!lifecycle) return '';
  if (ACTIVE_REPORT_STATES.has(lifecycle.state)) {
    const receivedAt = lifecycle.receivedAt
      ? new Date(lifecycle.receivedAt).getTime()
      : Number.NaN;
    if (!Number.isFinite(receivedAt) || Date.now() - receivedAt >= REPORT_STALE_AFTER_MS) {
      return `Run ${lifecycle.runNumber}: status unavailable`;
    }
  }
  return `Run ${lifecycle.runNumber}: ${lifecycle.state}`;
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
    null,
  );
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);

  if (!stream.lifecycle) return null;

  const active = operation && ACTIVE_OPERATION.has(operation.status);
  const continueAvailable = canContinue(stream) && !active && !conflicted;

  const start = async () => {
    const request = retryRequest.current ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: stream.lifecycle!.revision,
    };
    retryRequest.current = request;
    setBusy(true);
    setConflicted(false);
    try {
      let created: OwnerContinuationOperation;
      try {
        created = await api.createContinuation(stream.id, request);
      } catch (error) {
        if (isExplainedFailure(error)) throw error;
        created = await api.createContinuation(stream.id, request);
      }
      retryRequest.current = null;
      setOperation(created);
      reload();
      snackbar.success('Continuation preparation started.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        retryRequest.current = null;
        setConflicted(true);
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
      setOperation(refreshed);
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
      setOperation(cancelled);
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
          {lifecycleStatus(stream)}
        </Typography>
        {stream.completedRecording ? (
          <Typography variant="body2">
            Previous replay: run {stream.completedRecording.runNumber}, master index{' '}
            {stream.completedRecording.master.index}
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
