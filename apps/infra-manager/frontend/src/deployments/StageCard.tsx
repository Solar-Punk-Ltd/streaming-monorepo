import { useState } from 'react';
import { Button, Stack, TextField, Typography } from '@mui/material';

import { getErrorMessage, INGEST_HOST_HELP, stageRegistrationLine } from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import { SectionCard } from '../components/SectionCard';
import { updateIngestHost } from '../data';
import { FormField } from '../forms/FormField';
import type { Profile } from '../types';
import { ingestHostDraftProblem, ingestHostToSave, ingestHostView } from './stageText';
import { useSecondsTicker, useStageRegistration } from './useStageRegistration';

const FIELD_ID = 'stage-ingest-host';

/**
 * The deployment as a stage of the web2 admin: the public address encoders
 * dial, edited in place and saved on its own, since no container reads it, and
 * how the manager's last push of the stage record went.
 */
export function StageCard({ profile, serverHost }: { profile: Profile; serverHost: string }) {
  const { mergeProfiles } = useDeployments();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registration = useStageRegistration(profile.name);
  const now = useSecondsTicker(registration !== undefined && registration !== null);

  const view = ingestHostView(profile, serverHost);
  const problem = draft === null ? null : ingestHostDraftProblem(draft);
  const unchanged = draft !== null && ingestHostToSave(draft) === (profile.ingest_host ?? null);

  const stopEditing = () => {
    setDraft(null);
    setError(null);
  };

  const save = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      mergeProfiles([await updateIngestHost(profile.name, value)]);
      setDraft(null);
      toast(value === null ? 'Ingest address reset to the resolved host.' : 'Ingest address saved.');
    } catch (caught) {
      setError(getErrorMessage(caught, 'failed to save the ingest address'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Web2 admin stage"
      actions={
        draft === null ? (
          <Button size="small" onClick={() => setDraft(profile.ingest_host ?? '')}>
            Edit
          </Button>
        ) : (
          <>
            <Button size="small" onClick={stopEditing} disabled={saving}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => void save(ingestHostToSave(draft))}
              disabled={saving || problem !== null || unchanged}
            >
              Save
            </Button>
          </>
        )
      }
    >
      <Stack spacing={1.25}>
        {draft === null ? (
          <Stack spacing={0.25}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Public ingest address
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
              data-testid="ingest-host"
            >
              {view.address}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {view.source}
            </Typography>
          </Stack>
        ) : (
          <FormField label="Public ingest address" htmlFor={FIELD_ID} hint={INGEST_HOST_HELP} error={problem ?? error}>
            <TextField
              id={FIELD_ID}
              size="small"
              fullWidth
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={ingestHostView({ ...profile, ingest_host: null }, serverHost).address}
              slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'none' } }}
            />
          </FormField>
        )}
        {draft === null && view.own && (
          <Button size="small" sx={{ alignSelf: 'flex-start' }} onClick={() => void save(null)} disabled={saving}>
            Use the resolved host
          </Button>
        )}
        <Typography variant="body2" data-testid="stage-registration">
          {registration === undefined
            ? 'Web2 admin registration: not read yet'
            : stageRegistrationLine(registration, now)}
        </Typography>
      </Stack>
    </SectionCard>
  );
}
