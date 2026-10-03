import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, Stack, TextField, Typography } from '@mui/material';

import {
  type CatalogueNodeAnswer,
  cataloguePushLine,
  formatDateTime,
  getErrorMessage,
  shortHex,
} from '@streaming-infra-manager/common';

import { useDeployments } from '../app/useDeploymentsStore';
import { useToast } from '../app/ToastProvider';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import { SectionCard } from '../components/SectionCard';
import { ApiError } from '../http';
import { fetchStamps } from '../uploaders/stampApi';
import { clearCatalogueNode, releaseCatalogueNode, saveCatalogueNode } from './catalogueNodeApi';
import {
  CATALOGUE_CLEARED,
  CATALOGUE_LEAD,
  CATALOGUE_MOVE_CONFIRM,
  CATALOGUE_MOVE_TITLE,
  CATALOGUE_MOVED,
  CATALOGUE_NO_CANDIDATES,
  CATALOGUE_NONE,
  CATALOGUE_RELEASE_CONFIRM,
  CATALOGUE_RELEASE_LABEL,
  CATALOGUE_RELEASE_TITLE,
  CATALOGUE_RELEASED,
  CATALOGUE_SAVE_RACE,
  CATALOGUE_SAVED,
  catalogueApiWarning,
  type CatalogueBatchView,
  catalogueBatchViews,
  catalogueCandidates,
  catalogueMoveConfirmText,
  catalogueMoveLabel,
  catalogueMoveSteps,
  catalogueMovingLine,
  cataloguePinnedNote,
  catalogueReadingLine,
  catalogueReleaseConfirmText,
} from './catalogueNodeView';
import type { CatalogueNodeLoad } from './useCatalogueNode';

export const CATALOGUE_NODE_FIELD_ID = 'catalogue-node-deployment';
export const CATALOGUE_BATCH_FIELD_ID = 'catalogue-node-batch';

const WRAPPED_ALERT = { '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } } as const;

/**
 * The brand's catalogue node on the Manager settings page, beside the web2 admin link: the Bee-only deployment and
 * the immutable batch pinned for it, what the manager last read of that batch, and how its last push to the admin
 * went. Choosing refuses, with the manager's own sentence, a deployment that is more than a Bee node or a pool's
 * rung, and a batch that is mutable, of a kind the node did not report, or expired. Once a batch is pinned, another
 * one moves the catalogue after a confirm, and while that move is pending the card shows the batch moved from, the
 * steps in the web2 admin, and the release that ends it.
 */
export function CatalogueNodeCard({ load }: { load: CatalogueNodeLoad }) {
  const { answer } = load;
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SectionCard title="Catalogue node">
      {answer ? (
        <CatalogueEditor key={answer.revision} answer={answer} load={load} notice={notice} onNotice={setNotice} />
      ) : load.error ? (
        <Alert
          severity="warning"
          sx={WRAPPED_ALERT}
          action={
            <Button color="inherit" size="small" onClick={() => void load.reload()}>
              Try again
            </Button>
          }
        >
          Could not read the catalogue node. {load.error}
        </Alert>
      ) : (
        <Stack sx={{ alignItems: 'center', py: 2 }}>
          <CircularProgress size={24} aria-label="Reading the catalogue node" />
        </Stack>
      )}
    </SectionCard>
  );
}

/**
 * The node's batches as the card offers them, read when a node is chosen: once one is pinned every other one is a
 * move, and while a move is pending a third one is refused.
 */
function useNodeBatches(name: string, pinnedBatchId: string | null, movingFromBatchId: string | null) {
  const [batches, setBatches] = useState<CatalogueBatchView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBatches(null);
    setError(null);
    if (!name) return undefined;
    const controller = new AbortController();
    fetchStamps(name, controller.signal)
      .then((stamps) => setBatches(catalogueBatchViews(stamps, pinnedBatchId, movingFromBatchId)))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(getErrorMessage(caught));
      });
    return () => controller.abort();
  }, [name, pinnedBatchId, movingFromBatchId]);
  return { batches, error };
}

function CatalogueEditor({
  answer,
  load,
  notice,
  onNotice,
}: {
  answer: CatalogueNodeAnswer;
  load: CatalogueNodeLoad;
  notice: string | null;
  onNotice: (notice: string | null) => void;
}) {
  const toast = useToast();
  const { profiles, groups } = useDeployments();
  const { designation, pinned, movingFrom } = answer;
  // Designated, the card offers a clear, and the picker only once a move is asked for.
  const [choosingMove, setChoosingMove] = useState(false);
  const editing = designation === null || choosingMove;
  const [node, setNode] = useState(pinned?.profileName ?? '');
  const [batch, setBatch] = useState(pinned?.batchId ?? '');
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { batches, error: batchesError } = useNodeBatches(
    editing ? node : '',
    pinned?.batchId ?? null,
    movingFrom?.batchId ?? null,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const candidates = catalogueCandidates(profiles ?? [], groups);
  const nodeProblem = candidates.find((candidate) => candidate.name === node)?.problem ?? null;
  const chosenBatch = batches?.find((view) => view.batchId === batch) ?? null;
  const batchProblem = chosenBatch?.problem ?? null;
  const canSave = !saving && node !== '' && chosenBatch !== null && !nodeProblem && !batchProblem;

  const run = async (action: () => Promise<CatalogueNodeAnswer>, done: string) => {
    setSaving(true);
    setSaveProblem(null);
    onNotice(null);
    try {
      load.replace(await action());
      toast(done, 'success');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'manager_settings_changed') {
        onNotice(CATALOGUE_SAVE_RACE);
        await load.reload();
      } else {
        setSaveProblem(getErrorMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  const isMove = chosenBatch?.move === true;
  const save = () =>
    run(
      () =>
        saveCatalogueNode({
          expectedRevision: answer.revision,
          profileName: node,
          batchId: batch,
          ...(isMove ? { move: true } : {}),
        }),
      isMove ? CATALOGUE_MOVED : CATALOGUE_SAVED,
    );
  const clear = () => run(() => clearCatalogueNode({ expectedRevision: answer.revision }), CATALOGUE_CLEARED);
  const release = () => run(() => releaseCatalogueNode({ expectedRevision: answer.revision }), CATALOGUE_RELEASED);

  const askSave = () => {
    if (!isMove || !pinned) {
      void save();
      return;
    }
    setConfirm({
      title: CATALOGUE_MOVE_TITLE,
      body: catalogueMoveConfirmText(pinned.batchId, batch),
      confirmLabel: CATALOGUE_MOVE_CONFIRM,
      onConfirm: () => void save(),
    });
  };
  const askRelease = () => {
    if (!movingFrom) return;
    setConfirm({
      title: CATALOGUE_RELEASE_TITLE,
      body: catalogueReleaseConfirmText(movingFrom),
      confirmLabel: CATALOGUE_RELEASE_CONFIRM,
      danger: true,
      onConfirm: () => void release(),
    });
  };

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }} data-catalogue-node>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {CATALOGUE_LEAD}
      </Typography>

      {designation ? (
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            <strong>{designation.profileName}</strong>, batch <code>{shortHex(designation.batchId)}</code>
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
            {catalogueReadingLine(answer.reading)}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Designated {formatDateTime(designation.designatedAt)}
            {designation.designatedBy ? ` by ${designation.designatedBy}` : ''}
          </Typography>
        </Stack>
      ) : (
        <Alert severity="info" sx={WRAPPED_ALERT}>
          {CATALOGUE_NONE}
          {pinned ? ` ${cataloguePinnedNote(pinned)}` : ''}
        </Alert>
      )}

      {designation && catalogueApiWarning(answer) ? (
        <Alert severity="warning" sx={WRAPPED_ALERT} data-catalogue-api-exposed>
          {catalogueApiWarning(answer)}
        </Alert>
      ) : null}

      <Typography variant="caption" data-catalogue-push sx={{ color: 'text.secondary' }}>
        {cataloguePushLine(answer.lastPush, now)}
      </Typography>

      {movingFrom && pinned ? (
        <Alert severity="warning" sx={WRAPPED_ALERT} data-catalogue-move>
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              <strong>{catalogueMovingLine(movingFrom)}</strong>
            </Typography>
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              {catalogueReadingLine(movingFrom.reading)}
            </Typography>
            <Typography variant="caption">
              Started {formatDateTime(movingFrom.startedAt)}
              {movingFrom.startedBy ? ` by ${movingFrom.startedBy}` : ''}
            </Typography>
            <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
              {catalogueMoveSteps(pinned.batchId).map((step) => (
                <Typography key={step} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {step}
                </Typography>
              ))}
            </Box>
            <Box>
              <Button size="small" color="warning" variant="outlined" disabled={saving} onClick={askRelease}>
                {CATALOGUE_RELEASE_LABEL}
              </Button>
            </Box>
          </Stack>
        </Alert>
      ) : (
        answer.lastRelease && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Previous batch released {formatDateTime(answer.lastRelease.at)}
            {answer.lastRelease.by ? ` by ${answer.lastRelease.by}` : ''}
          </Typography>
        )
      )}

      {editing ? (
        candidates.length === 0 ? (
          <Alert severity="info" sx={WRAPPED_ALERT}>
            {CATALOGUE_NO_CANDIDATES}
          </Alert>
        ) : (
          <Stack spacing={2}>
            <TextField
              id={CATALOGUE_NODE_FIELD_ID}
              select
              label="Bee-only deployment"
              size="small"
              fullWidth
              value={node}
              disabled={saving}
              error={nodeProblem !== null}
              helperText={nodeProblem ?? 'A deployment of this manager that is nothing but a Bee node.'}
              onChange={(event) => {
                setNode(event.target.value);
                setBatch('');
                setSaveProblem(null);
              }}
            >
              {candidates.map((candidate) => (
                <MenuItem key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </MenuItem>
              ))}
            </TextField>

            {node !== '' && !nodeProblem && (
              <TextField
                id={CATALOGUE_BATCH_FIELD_ID}
                select
                label="Batch"
                size="small"
                fullWidth
                value={chosenBatch ? batch : ''}
                disabled={saving || batches === null || batches.length === 0}
                error={batchProblem !== null || batchesError !== null}
                helperText={
                  batchProblem ??
                  batchesError ??
                  (batches === null
                    ? 'Reading the node’s batches'
                    : batches.length === 0
                      ? 'This node holds no batch. Buy an immutable one on its Storage and funding card.'
                      : 'One of the batches the node holds, as its Storage and funding card lists them.')
                }
                onChange={(event) => {
                  setBatch(event.target.value);
                  setSaveProblem(null);
                }}
              >
                {(batches ?? []).map((view) => (
                  <MenuItem key={view.batchId} value={view.batchId} sx={{ whiteSpace: 'normal' }}>
                    {view.label}
                  </MenuItem>
                ))}
              </TextField>
            )}

            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Button variant="contained" size="small" disabled={!canSave} onClick={askSave}>
                {saving ? 'Saving' : isMove ? catalogueMoveLabel(batch) : pinned ? 'Designate again' : 'Save'}
              </Button>
              {designation && (
                <Button size="small" disabled={saving} onClick={() => setChoosingMove(false)}>
                  Cancel
                </Button>
              )}
            </Stack>
          </Stack>
        )
      ) : (
        <Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button size="small" disabled={saving} onClick={() => setChoosingMove(true)}>
              Move to another batch
            </Button>
            <Button size="small" color="error" disabled={saving} onClick={() => void clear()}>
              Clear the designation
            </Button>
          </Stack>
        </Box>
      )}

      {(saveProblem ?? notice) && (
        <Alert severity={saveProblem ? 'error' : 'info'} sx={WRAPPED_ALERT}>
          {saveProblem ?? notice}
        </Alert>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Stack>
  );
}
