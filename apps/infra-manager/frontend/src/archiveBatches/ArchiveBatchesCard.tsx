import { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, MenuItem, Stack, TextField, Typography } from '@mui/material';

import {
  ARCHIVE_LABEL_MAX_LENGTH,
  type ArchiveBatchesAnswer,
  type ArchiveBatchRow,
  archiveLabelProblem,
  getErrorMessage,
  shortHex,
} from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import { catalogueReadingLine } from '../catalogueNode/catalogueNodeView';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import { SectionCard } from '../components/SectionCard';
import { ApiError } from '../http';
import { adoptArchiveBatch, removeArchiveBatch } from './archiveBatchesApi';
import {
  ARCHIVE_ADOPTED,
  ARCHIVE_LEAD,
  ARCHIVE_NO_CANDIDATES,
  ARCHIVE_NO_CATALOGUE_NODE,
  ARCHIVE_NONE,
  ARCHIVE_REMOVE_CONFIRM,
  ARCHIVE_REMOVE_TITLE,
  ARCHIVE_REMOVED,
  ARCHIVE_SAVE_RACE,
  archiveBatchOrigin,
  archiveBatchRemoveProblem,
  archiveBatchTitle,
  archiveBatchWritableLine,
  archiveCandidateLabel,
  archiveRemoveConfirmText,
} from './archiveBatchesView';
import type { ArchiveBatchesLoad } from './useArchiveBatches';

export const ARCHIVE_BATCH_FIELD_ID = 'archive-batch-candidate';
export const ARCHIVE_LABEL_FIELD_ID = 'archive-batch-label';

const WRAPPED_ALERT = { '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } } as const;

/**
 * The brand's archive batches on the Manager settings page, under the catalogue node card: a read-only list of the
 * immutable batches the web2 admin copies recordings onto, each with its last reading and whether the admin can copy
 * onto it, and two actions. **Adopt** makes one of the catalogue node's other batches an archive batch, refused with
 * the manager's own sentence for a batch that cannot be one. **Remove** takes an expired batch off the list, after a
 * confirm.
 */
export function ArchiveBatchesCard({ load }: { load: ArchiveBatchesLoad }) {
  const { answer } = load;
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SectionCard title="Archive batches">
      {answer ? (
        <ArchiveBatchesBody key={answer.revision} answer={answer} load={load} notice={notice} onNotice={setNotice} />
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
          Could not read the archive batches. {load.error}
        </Alert>
      ) : (
        <Stack sx={{ alignItems: 'center', py: 2 }}>
          <CircularProgress size={24} aria-label="Reading the archive batches" />
        </Stack>
      )}
    </SectionCard>
  );
}

function ArchiveBatchesBody({
  answer,
  load,
  notice,
  onNotice,
}: {
  answer: ArchiveBatchesAnswer;
  load: ArchiveBatchesLoad;
  notice: string | null;
  onNotice: (notice: string | null) => void;
}) {
  const toast = useToast();
  const { profiles } = useDeployments();
  // Gone only once the deployments have been read and none is called this.
  const deploymentGone = (name: string) => profiles !== null && !profiles.some((profile) => profile.name === name);
  const [batch, setBatch] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const chosen = answer.candidates.find((candidate) => candidate.batchId === batch) ?? null;
  const trimmed = label.trim();
  const labelProblem = trimmed === '' ? null : archiveLabelProblem(trimmed);
  const canAdopt = !saving && chosen !== null && chosen.problem === null && labelProblem === null;

  const run = async (action: () => Promise<ArchiveBatchesAnswer>, done: string) => {
    setSaving(true);
    setSaveProblem(null);
    onNotice(null);
    try {
      load.replace(await action());
      toast(done, 'success');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'manager_settings_changed') {
        onNotice(ARCHIVE_SAVE_RACE);
        await load.reload();
      } else {
        setSaveProblem(getErrorMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  const adopt = () =>
    run(
      () => adoptArchiveBatch(batch, { expectedRevision: answer.revision, label: trimmed === '' ? null : trimmed }),
      ARCHIVE_ADOPTED,
    );
  const askRemove = (row: ArchiveBatchRow) =>
    setConfirm({
      title: ARCHIVE_REMOVE_TITLE,
      body: archiveRemoveConfirmText(row, deploymentGone(row.profileName)),
      confirmLabel: ARCHIVE_REMOVE_CONFIRM,
      danger: true,
      onConfirm: () =>
        void run(() => removeArchiveBatch(row.batchId, { expectedRevision: answer.revision }), ARCHIVE_REMOVED),
    });

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }} data-archive-batches>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {ARCHIVE_LEAD}
      </Typography>

      {answer.batches.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {ARCHIVE_NONE}
        </Typography>
      ) : (
        <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0, listStyle: 'none', minWidth: 0 }}>
          {answer.batches.map((row) => {
            const removeProblem = archiveBatchRemoveProblem(row, deploymentGone(row.profileName));
            return (
              <Box component="li" key={row.batchId} data-archive-batch={row.batchId} sx={{ minWidth: 0 }}>
                <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      <strong>{archiveBatchTitle(row)}</strong>
                      {row.label ? (
                        <>
                          , batch <code>{shortHex(row.batchId)}</code>
                        </>
                      ) : null}
                    </Typography>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={row.writable ? 'success' : 'default'}
                      label={row.writable ? 'Writable' : 'Not writable'}
                    />
                  </Stack>
                  <Typography variant="caption" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
                    {catalogueReadingLine(row.reading)}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
                    {archiveBatchWritableLine(row, answer.catalogueProfileName)}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {archiveBatchOrigin(row)}
                  </Typography>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Button
                      size="small"
                      color="error"
                      disabled={saving || removeProblem !== null}
                      onClick={() => askRemove(row)}
                    >
                      Remove
                    </Button>
                    {removeProblem && (
                      <Typography variant="caption" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
                        {removeProblem}
                      </Typography>
                    )}
                  </Stack>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

      {answer.catalogueProfileName === null ? (
        <Alert severity="info" sx={WRAPPED_ALERT}>
          {ARCHIVE_NO_CATALOGUE_NODE}
        </Alert>
      ) : answer.candidatesError ? (
        <Alert severity="warning" sx={WRAPPED_ALERT}>
          {answer.candidatesError}
        </Alert>
      ) : answer.candidates.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {ARCHIVE_NO_CANDIDATES}
        </Typography>
      ) : (
        <Stack spacing={2}>
          <TextField
            id={ARCHIVE_BATCH_FIELD_ID}
            select
            label={`Adopt a batch of ${answer.catalogueProfileName}`}
            size="small"
            fullWidth
            value={chosen ? batch : ''}
            disabled={saving}
            error={chosen?.problem != null}
            helperText={chosen?.problem ?? 'One of the other batches the catalogue node holds.'}
            onChange={(event) => {
              setBatch(event.target.value);
              setSaveProblem(null);
            }}
          >
            {answer.candidates.map((candidate) => (
              <MenuItem key={candidate.batchId} value={candidate.batchId} sx={{ whiteSpace: 'normal' }}>
                {archiveCandidateLabel(candidate)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            id={ARCHIVE_LABEL_FIELD_ID}
            label="Label"
            size="small"
            fullWidth
            value={label}
            disabled={saving}
            error={labelProblem !== null}
            helperText={labelProblem ?? `A name for it, up to ${ARCHIVE_LABEL_MAX_LENGTH} characters, or none.`}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Box>
            <Button variant="contained" size="small" disabled={!canAdopt} onClick={() => void adopt()}>
              {saving ? 'Saving' : 'Adopt'}
            </Button>
          </Box>
        </Stack>
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
