import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import type {
  LegacyAdoptionCreateRequest,
  OwnerLegacyAdoptionOperation,
  Stream,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { ApiError } from '../http';
import { useSnackbar } from './Snackbar';

function isExplainedFailure(error: unknown): boolean {
  return error instanceof ApiError;
}

function newerOperation(
  current: OwnerLegacyAdoptionOperation | null,
  incoming: OwnerLegacyAdoptionOperation,
): OwnerLegacyAdoptionOperation {
  if (!current || current.operationId !== incoming.operationId) return incoming;
  return incoming.revision >= current.revision ? incoming : current;
}

export function LegacyPreparationPanel({
  stream,
  reload,
}: {
  stream: Stream;
  reload: () => void;
}) {
  const snackbar = useSnackbar();
  const retryRequest = useRef<LegacyAdoptionCreateRequest | null>(null);
  const actionGeneration = useRef(0);
  const [operation, setOperation] = useState<OwnerLegacyAdoptionOperation | null>(
    stream.legacyAdoption ?? null,
  );
  const currentOperationId = useRef(operation?.operationId ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () => () => {
      actionGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    currentOperationId.current = operation?.operationId ?? null;
  }, [operation]);

  useEffect(() => {
    const incoming = stream.legacyAdoption;
    setOperation((current) => {
      if (incoming) {
        return newerOperation(current, incoming);
      }
      return stream.lifecycle || stream.status !== 'vod' ? null : current;
    });
  }, [stream.legacyAdoption, stream.lifecycle, stream.status]);

  if (stream.lifecycle || stream.status !== 'vod') return null;

  const start = async () => {
    const startedFromOperationId = currentOperationId.current;
    const generation = (actionGeneration.current += 1);
    const isCurrent = () => actionGeneration.current === generation;
    setBusy(true);
    try {
      const request =
        retryRequest.current ??
        ({
          requestId: crypto.randomUUID(),
          expectedCandidateDigest:
            await api.fetchLegacyPreparationCandidate(stream.id),
        } satisfies LegacyAdoptionCreateRequest);
      if (!isCurrent()) return;
      retryRequest.current = request;

      let created: OwnerLegacyAdoptionOperation;
      try {
        created = await api.createLegacyPreparation(stream.id, request);
      } catch (error) {
        if (isExplainedFailure(error)) throw error;
        if (!isCurrent()) return;
        created = await api.createLegacyPreparation(stream.id, request);
      }
      if (
        !isCurrent() ||
        currentOperationId.current !== startedFromOperationId ||
        created.streamId !== stream.id ||
        created.requestId !== request.requestId
      ) {
        return;
      }
      retryRequest.current = null;
      currentOperationId.current = created.operationId;
      setOperation((current) => newerOperation(current, created));
      reload();
      snackbar.success('Recording check started.');
    } catch (error) {
      if (isCurrent()) {
        if (error instanceof ApiError && error.status === 409) {
          retryRequest.current = null;
          reload();
        }
        snackbar.error(
          errorMessage(error, 'Could not check the previous recording'),
        );
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const refresh = async () => {
    if (!operation) return;
    const operationId = operation.operationId;
    const generation = (actionGeneration.current += 1);
    const isCurrent = () => actionGeneration.current === generation;
    setBusy(true);
    try {
      const refreshed = await api.fetchLegacyPreparation(
        stream.id,
        operationId,
      );
      if (
        !isCurrent() ||
        currentOperationId.current !== operationId ||
        refreshed.streamId !== stream.id ||
        refreshed.operationId !== operationId
      ) {
        return;
      }
      setOperation((current) =>
        current?.operationId === operationId
          ? newerOperation(current, refreshed)
          : current,
      );
      reload();
    } catch (error) {
      if (isCurrent()) {
        snackbar.error(
          errorMessage(error, 'Could not refresh the recording check'),
        );
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const cancel = async () => {
    if (operation?.status !== 'pending') return;
    const operationId = operation.operationId;
    const generation = (actionGeneration.current += 1);
    const isCurrent = () => actionGeneration.current === generation;
    setBusy(true);
    try {
      const cancelled = await api.cancelLegacyPreparation(stream.id, operationId);
      if (
        !isCurrent() ||
        currentOperationId.current !== operationId ||
        cancelled.streamId !== stream.id ||
        cancelled.operationId !== operationId
      ) {
        return;
      }
      retryRequest.current = null;
      currentOperationId.current = null;
      setOperation((current) =>
        current?.operationId === operationId ? null : current,
      );
      reload();
      snackbar.success('Recording check cancelled.');
    } catch (error) {
      if (isCurrent()) {
        snackbar.error(
          errorMessage(error, 'Could not cancel the recording check'),
        );
        reload();
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const pending = operation?.status === 'pending';
  const failed = operation?.status === 'failed';

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Continue this recording</Typography>
        <Typography variant="body2">
          Before this recording can continue, its saved media must be checked
          once for completeness and compatibility.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Your existing replay stays available while this one-time check runs.
        </Typography>
        {pending ? (
          <Alert severity="info">Checking the previous recording.</Alert>
        ) : null}
        {failed ? (
          <Alert severity="error">
            {operation.failure ?? 'The previous recording could not be checked.'}
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} alignItems="center">
          {!operation || failed ? (
            <Button variant="contained" onClick={() => void start()} disabled={busy}>
              {failed ? 'Try preparation again' : 'Prepare to continue'}
            </Button>
          ) : null}
          {pending ? (
            <Button onClick={() => void refresh()} disabled={busy}>
              Refresh preparation
            </Button>
          ) : null}
          {pending ? (
            <Button color="warning" onClick={() => void cancel()} disabled={busy}>
              Cancel preparation
            </Button>
          ) : null}
          {busy ? <CircularProgress size={20} /> : null}
        </Stack>
      </Stack>
    </Paper>
  );
}
