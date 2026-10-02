import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import type { CatalogueMoveStatus, CatalogueMoveSummary } from '@streaming-monorepo/web2-admin-common';

import { errorMessage } from '../../errors';
import { shortHex } from '../../format';

/** What the card says once a move is done: the history is under the new batch, and what is left to do. */
export function moveDoneText(move: NonNullable<CatalogueMoveStatus['latest']>): string {
  const slots = move.slotsTotal ?? move.slotsDone;
  const moved = `The catalogue was moved to batch ${shortHex(move.targetBatchId)}: ${slots} slot${slots === 1 ? '' : 's'}, and the admin writes with it now.`;
  if (move.fromBatchId && move.fromBatchId !== move.targetBatchId) {
    return `${moved} You can now release the previous batch, ${shortHex(move.fromBatchId)}, in the manager.`;
  }
  return moved;
}

/** Whether a move is done and is still the state of things: nothing waits, and its batch is pinned and designated. */
export function moveIsCurrent(move: CatalogueMoveStatus, latest: CatalogueMoveSummary): boolean {
  return (
    latest.state === 'done' &&
    move.waiting === null &&
    move.pinnedBatchId === latest.targetBatchId &&
    move.designatedBatchId === latest.targetBatchId
  );
}

/**
 * Moving the catalogue's history onto the batch the manager designated: shown on the Stages page while a move waits,
 * runs, failed or has just finished. The viewer walks the catalogue's slots and stops at the first it cannot read, so
 * every slot is uploaded again under the new batch before the old one lapses. The admin does it; the manager then
 * releases the old batch when the operator says so.
 */
export function CatalogueMoveCard({
  move,
  onStart,
}: {
  move: CatalogueMoveStatus | null;
  onStart: (targetBatchId: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!move) return null;
  const { waiting, refusal, latest } = move;
  const running = latest?.state === 'running';
  const failed = latest?.state === 'failed' && waiting !== null && latest.targetBatchId === waiting.targetBatchId;
  // Done, and still what the catalogue is written with and the manager designates: only then is the previous batch
  // free to release. A move since, or a designation of another batch, makes the old message untrue.
  const done = latest !== null && moveIsCurrent(move, latest);
  if (!running && !waiting && !done) return null;

  const start = async (targetBatchId: string) => {
    setBusy(true);
    setError(null);
    try {
      await onStart(targetBatchId);
      setConfirming(false);
    } catch (e: unknown) {
      setError(errorMessage(e, 'The move could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" component="h2">
          Catalogue move
        </Typography>

        {running && latest ? (
          <>
            <Typography variant="body2">
              Moving the catalogue to batch {shortHex(latest.targetBatchId)}: {latest.slotsDone}
              {latest.slotsTotal !== null ? ` of ${latest.slotsTotal}` : ''} slots.
            </Typography>
            <LinearProgress
              aria-label="Catalogue move progress"
              variant={latest.slotsTotal ? 'determinate' : 'indeterminate'}
              value={latest.slotsTotal ? Math.min(100, (100 * latest.slotsDone) / latest.slotsTotal) : undefined}
            />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Publishing goes on meanwhile, with the batch the catalogue is written with now. Keep that batch alive
              until the move is done.
            </Typography>
          </>
        ) : null}

        {!running && waiting ? (
          <>
            <Typography variant="body2">
              The manager designated batch {shortHex(waiting.targetBatchId)}, and {waiting.slots} slot
              {waiting.slots === 1 ? '' : 's'} of the catalogue have to be stamped under it before the admin can write
              with it. Until then the catalogue is written with{' '}
              {waiting.fromBatchId ? `batch ${shortHex(waiting.fromBatchId)}` : 'the batch it has'}.
            </Typography>
            {failed && latest ? (
              <Alert severity="error">
                The move stopped at slot {latest.slotsDone}: {latest.error}
              </Alert>
            ) : null}
            {refusal ? (
              <Alert severity={refusal.problem === 'disabled' ? 'info' : 'warning'}>{refusal.message}</Alert>
            ) : (
              <Stack direction="row">
                <Button variant="contained" onClick={() => setConfirming(true)}>
                  {failed ? 'Retry the move' : `Move the catalogue to batch ${shortHex(waiting.targetBatchId)}`}
                </Button>
              </Stack>
            )}
            {error ? <Alert severity="error">{error}</Alert> : null}
            <Dialog open={confirming} onClose={() => setConfirming(false)} maxWidth="xs" fullWidth>
              <DialogTitle>Move the catalogue to batch {shortHex(waiting.targetBatchId)}?</DialogTitle>
              <DialogContent>
                <DialogContentText component="div">
                  Every slot of the catalogue, {waiting.slots} of them, is uploaded again under batch{' '}
                  {shortHex(waiting.targetBatchId)} through the catalogue node, byte for byte, then every thumbnail a
                  stream names, published or not, and every one the latest entry names, and then the admin writes with
                  the new batch. Publishing goes on meanwhile. Keep the previous batch alive until this page says the
                  move is done; then release it in the manager.
                </DialogContentText>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void start(waiting.targetBatchId)} disabled={busy} variant="contained">
                  {failed ? 'Retry the move' : 'Move the catalogue'}
                </Button>
              </DialogActions>
            </Dialog>
          </>
        ) : null}

        {done && latest ? <Alert severity="success">{moveDoneText(latest)}</Alert> : null}
      </Stack>
    </Paper>
  );
}
