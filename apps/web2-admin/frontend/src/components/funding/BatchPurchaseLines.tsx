import { useState } from 'react';
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/material';
import {
  BATCH_PURCHASE_APPLY_TEXT,
  BATCH_PURCHASE_RESTART_CONFIRM,
  batchPurchaseOffersCheck,
  batchPurchaseStageRestartable,
  boughtBatchRanOut,
  type BatchPurchase,
  type BatchPurchaseMove,
  type BatchPurchaseStage,
} from '@streaming-monorepo/web2-admin-common';

import { errorMessage } from '../../errors';
import { shortHex } from '../../format';
import { ConfirmDialog } from '../ConfirmDialog';
import { ClearedThumbnails } from '../stages/ClearedThumbnails';
import { BOUGHT_BATCH_RAN_OUT, purchaseOpen, purchaseStateText, purchaseWhat } from './batchPurchases';

/** The colour of a stage's line: red when its restart failed, orange while it waits on something, green once applied. */
function applyColor(apply: BatchPurchaseStage['apply']): string {
  switch (apply) {
    case 'failed':
      return 'error.main';
    case 'waiting_live':
    case 'waiting_unknown':
    case 'waiting_settings':
    case 'not_following':
      return 'warning.main';
    case 'applied':
      return 'success.main';
    default:
      return 'text.secondary';
  }
}

/** The title of Restart now's confirm. */
export function restartTitle(stageName: string): string {
  return `Restart the uploader of ${stageName} now?`;
}

/** Where the move of a catalogue purchase stands, in a sentence. */
export function moveText(move: BatchPurchaseMove): string {
  switch (move.state) {
    case 'waiting':
      return move.message
        ? `The move of the catalogue waits: ${move.message}`
        : 'The move of the catalogue is about to start.';
    case 'running': {
      const of = move.slotsTotal !== null ? ` of ${move.slotsTotal}` : '';
      return `Moving the catalogue onto the new batch: ${move.slotsDone}${of} slots.`;
    }
    case 'failed':
      return `The move of the catalogue stopped: ${move.message ?? 'no reason was given.'} Check again starts it from where it stopped.`;
    case 'done':
      return move.released
        ? 'The catalogue was moved onto the new batch, and the previous batch is released.'
        : 'The catalogue was moved onto the new batch. The previous batch is being released.';
  }
}

function StageLine({
  stage,
  onRestart,
}: {
  stage: BatchPurchaseStage;
  onRestart: (stage: BatchPurchaseStage) => void;
}) {
  return (
    <Stack
      component="li"
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
          {stage.name}
        </Typography>
        <Typography variant="body2" component="span" sx={{ color: applyColor(stage.apply) }}>
          {`: ${BATCH_PURCHASE_APPLY_TEXT[stage.apply]}`}
        </Typography>
        {stage.message ? (
          <Typography variant="caption" component="div" sx={{ color: 'text.secondary' }}>
            {stage.message}
          </Typography>
        ) : null}
      </Box>
      {batchPurchaseStageRestartable(stage) ? (
        <Button size="small" variant="outlined" onClick={() => onRestart(stage)} sx={{ flexShrink: 0 }}>
          Restart now
        </Button>
      ) : null}
    </Stack>
  );
}

/**
 * The latest purchase of a node, under its row on the Stamps tab: what was bought and where it stands, a line for each
 * stage whose uploader takes a rung's new batch, with Restart now while it waits for a broadcast, and for the catalogue
 * the move with its slots and the thumbnails it cleared. Check again is offered as the common `batchPurchaseOffersCheck`
 * says: not once the batch a failed purchase bought has run out, when the line says a new one can be bought.
 * Restart now asks first, in the common `BATCH_PURCHASE_RESTART_CONFIRM`.
 */
export function BatchPurchaseLines({
  purchase,
  onRestart,
  onCheck,
}: {
  purchase: BatchPurchase;
  onRestart: (purchaseId: string, stageId: string) => Promise<void>;
  onCheck: (purchaseId: string) => Promise<void>;
}) {
  const [restarting, setRestarting] = useState<BatchPurchaseStage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = purchase.state === 'buying' || purchase.state === 'waiting_usable';
  const stateColor =
    purchase.state === 'failed' ? 'error.main' : purchase.state === 'done' ? 'success.main' : 'text.primary';

  const act = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRestarting(null);
    } catch (e: unknown) {
      setError(errorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1} role="group" aria-label={`Purchase for ${purchase.nodeLabel}`}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {purchaseWhat(purchase)}
      </Typography>
      <Typography variant="body2" sx={{ color: stateColor }}>
        {purchaseStateText(purchase)}
      </Typography>
      {waiting ? <LinearProgress aria-label="Purchase progress" /> : null}
      {boughtBatchRanOut(purchase) ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {BOUGHT_BATCH_RAN_OUT}
        </Typography>
      ) : null}

      {purchase.stages.length > 0 ? (
        <Stack component="ul" spacing={0.75} aria-label="Stages" sx={{ m: 0, pl: 2 }}>
          {purchase.stages.map((stage) => (
            <StageLine key={stage.stageId} stage={stage} onRestart={setRestarting} />
          ))}
        </Stack>
      ) : null}

      {purchase.move ? (
        <Stack spacing={1}>
          <Typography variant="body2" sx={{ color: purchase.move.state === 'failed' ? 'error.main' : 'text.primary' }}>
            {moveText(purchase.move)}
          </Typography>
          {purchase.move.state === 'running' ? (
            <LinearProgress
              aria-label="Catalogue move progress"
              variant={purchase.move.slotsTotal ? 'determinate' : 'indeterminate'}
              value={
                purchase.move.slotsTotal
                  ? Math.min(100, (100 * purchase.move.slotsDone) / purchase.move.slotsTotal)
                  : undefined
              }
            />
          ) : null}
          <ClearedThumbnails streams={purchase.move.clearedThumbnails} />
        </Stack>
      ) : null}

      {batchPurchaseOffersCheck(purchase) ? (
        <Stack direction="row">
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={() => void act(() => onCheck(purchase.id), 'Check again did not go through.')}
          >
            Check again
          </Button>
        </Stack>
      ) : null}
      {error && !restarting ? <Alert severity="error">{error}</Alert> : null}
      {!purchaseOpen(purchase) && purchase.batchId ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {`Batch ${shortHex(purchase.batchId)}.`}
        </Typography>
      ) : null}

      <ConfirmDialog
        open={restarting !== null}
        title={restarting ? restartTitle(restarting.name) : ''}
        message={
          <>
            {BATCH_PURCHASE_RESTART_CONFIRM}
            {error && restarting ? (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            ) : null}
          </>
        }
        confirmText={busy ? 'Restarting…' : 'Restart now'}
        busy={busy}
        onConfirm={() => {
          if (restarting) {
            const { stageId } = restarting;
            void act(() => onRestart(purchase.id, stageId), 'The restart could not be asked for.');
          }
        }}
        onCancel={() => {
          setRestarting(null);
          setError(null);
        }}
      />
    </Stack>
  );
}
