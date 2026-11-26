import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import HelpOutlineOutlinedIcon from '@mui/icons-material/HelpOutlineOutlined';
import {
  EMAIL_PROVIDER_KINDS,
  EMAIL_PROVIDER_NAMES,
  NOTICE_SERVICE_NAMES,
  NOTICE_SERVICE_NOT_SAVED_ERROR,
  NOTICE_SERVICE_SECRET_NAMES,
  type EmailProviderKind,
  type NoticeServiceView,
  type NoticesView,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { ApiError } from '../../http';
import { ConfirmDialog } from '../ConfirmDialog';
import { PasswordDialog } from '../funding/PasswordDialog';
import { destinationsText, noticeCount } from './noticeText';
import {
  secretName,
  serviceDraftChanged,
  serviceDraftOf,
  serviceDraftProblems,
  serviceDraftRequest,
  type ServiceDraft,
} from './serviceDraft';
import { ServiceSetup } from './ServiceSetup';

/** What the API said of a write, for a card to show: its sentence, and whether the page should read the view again. */
function failure(e: unknown, fallback: string): { text: string; reload: boolean } {
  return {
    text: errorMessage(e, fallback),
    reload: e instanceof ApiError && e.code === NOTICE_SERVICE_NOT_SAVED_ERROR,
  };
}

/**
 * How the service stands, as an admin reads it: who saved it, its last notice, its latest failure, how many
 * destinations on it are on and how many of those failed, and what waits for them. Counts alone of the users.
 */
function ServiceState({ service, now }: { service: NoticeServiceView; now: number }) {
  if (!service.saved) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Not saved yet.
      </Typography>
    );
  }
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2">
        {service.savedAt ? `Saved by ${service.savedBy ?? 'someone'}, ${formatAgo(service.savedAt, now)}.` : 'Saved.'}
      </Typography>
      <Typography variant="body2">
        {service.lastSentAt ? `Last notice sent ${formatAgo(service.lastSentAt, now)}.` : 'No notice sent yet.'}
      </Typography>
      {service.lastFailure ? (
        <Typography variant="body2" sx={{ color: 'error.main' }}>
          {`The latest failure${service.lastFailureAt ? `, ${formatAgo(service.lastFailureAt, now)}` : ''}: ${service.lastFailure}`}
        </Typography>
      ) : null}
      <Typography variant="body2">{destinationsText(service)}</Typography>
      {service.waiting > 0 ? (
        <Typography variant="body2">{`${noticeCount(service.waiting)} ${service.waiting === 1 ? 'waits' : 'wait'} for its destinations.`}</Typography>
      ) : null}
    </Stack>
  );
}

/** The email service's own fields: the email service, the sender's address and the sender's name. */
function EmailFields({ draft, onDraft }: { draft: ServiceDraft; onDraft: (next: ServiceDraft) => void }) {
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' } }}>
      <TextField
        select
        id="notifications-email-provider"
        label="Email service"
        value={draft.provider}
        onChange={(event) => onDraft({ ...draft, provider: event.target.value as EmailProviderKind })}
        size="small"
      >
        {EMAIL_PROVIDER_KINDS.map((kind) => (
          <MenuItem key={kind} value={kind}>
            {EMAIL_PROVIDER_NAMES[kind]}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        id="notifications-email-sender-address"
        label="Sender address"
        value={draft.senderAddress}
        onChange={(event) => onDraft({ ...draft, senderAddress: event.target.value })}
        helperText="An address the service sends for."
        size="small"
      />
      <TextField
        id="notifications-email-sender-name"
        label="Sender name"
        value={draft.senderName}
        onChange={(event) => onDraft({ ...draft, senderName: event.target.value })}
        helperText="Shown beside the address. May be empty."
        size="small"
      />
    </Box>
  );
}

/**
 * One shared service on the Notifications page, for a user with the admin role: how it stands, its on/off switch, its
 * form, Save behind the password, Undo changes and Remove. The email service has its email service, sender and API
 * key; the Telegram service its bot token alone. The secret is write-only: the field starts empty, says whether one is
 * set, and left empty keeps it. The form as typed, `draft`, is the page's; null follows the saved service. The ?
 * beside the service's name shows and hides how to set it up.
 */
export function ServiceCard({
  service,
  available,
  draft,
  onDraft,
  onView,
  onReload,
}: {
  service: NoticeServiceView;
  /** Whether a service can be saved: the admin has its `BRAND_WALLET_SECRET`. */
  available: boolean;
  draft: ServiceDraft | null;
  onDraft: (next: ServiceDraft | null) => void;
  onView: (next: NoticesView) => void;
  onReload: () => void;
}) {
  const { kind } = service;
  const name = NOTICE_SERVICE_NAMES[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'save' | 'remove' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [setupShown, setSetupShown] = useState(false);
  const setupId = `notifications-${kind}-setup`;

  const shown = draft ?? serviceDraftOf(service);
  const problems = draft === null ? [] : serviceDraftProblems(kind, shown, service.saved);
  const changed = draft !== null && serviceDraftChanged(service, shown);
  const now = Date.now();

  /** Runs one write of the card, one at a time, and takes its answer as the page's view. */
  const write = async (run: () => Promise<NoticesView>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      onView(await run());
      return true;
    } catch (e: unknown) {
      const { text, reload } = failure(e, fallback);
      setError(text);
      if (reload) onReload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (password: string): Promise<'wrong-password' | void> => {
    setBusy(true);
    setSaveError(null);
    try {
      const { settings, secret } = serviceDraftRequest(kind, shown);
      onView(await api.saveNoticeService(kind, password, settings, secret));
      onDraft(null);
      setAsking(null);
    } catch (e: unknown) {
      setSaveError(errorMessage(e, 'The service could not be saved.'));
      if (e instanceof ApiError && e.code === 'invalid_credentials') return 'wrong-password';
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const remove = async () => {
    if (await write(() => api.removeNoticeService(kind), 'The service could not be removed.')) onDraft(null);
    setAsking(null);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-section>
      <Stack spacing={2}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
              {name}
            </Typography>
            <Tooltip title={`How to set up ${name}`}>
              <IconButton
                size="small"
                aria-label={`How to set up ${name}`}
                aria-expanded={setupShown}
                aria-controls={setupShown ? setupId : undefined}
                onClick={() => setSetupShown((shown) => !shown)}
              >
                <HelpOutlineOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          <FormControlLabel
            control={
              <Switch
                checked={service.saved && service.enabled}
                disabled={!service.saved || busy}
                onChange={(event) =>
                  void write(
                    () => api.setNoticeServiceEnabled(kind, event.target.checked),
                    'The service could not be switched.',
                  )
                }
              />
            }
            label={`${name} on`}
          />
        </Stack>
        {setupShown ? <ServiceSetup kind={kind} id={setupId} /> : null}
        <ServiceState service={service} now={now} />
        {error ? (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {kind === 'email' ? <EmailFields draft={shown} onDraft={onDraft} /> : null}
        <TextField
          id={`notifications-${kind}-secret`}
          label={NOTICE_SERVICE_SECRET_NAMES[kind]}
          type="password"
          autoComplete="new-password"
          value={shown.secret}
          onChange={(event) => onDraft({ ...shown, secret: event.target.value })}
          helperText={service.saved ? 'Set. Leave the field empty to keep it.' : 'Not set.'}
          size="small"
          sx={{ maxWidth: 480 }}
        />
        {problems.map((problem) => (
          <Typography key={problem} variant="caption" sx={{ color: 'error.main' }}>
            {problem}
          </Typography>
        ))}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            disabled={!available || busy || !changed || problems.length > 0}
            onClick={() => {
              setSaveError(null);
              setAsking('save');
            }}
          >
            Save
          </Button>
          <Button disabled={draft === null || busy} onClick={() => onDraft(null)}>
            Undo changes
          </Button>
          <Button color="error" disabled={!service.saved || busy} onClick={() => setAsking('remove')}>
            Remove
          </Button>
        </Stack>
      </Stack>
      {asking === 'save' ? (
        <PasswordDialog
          title={`Save the ${name} service`}
          confirmText="Save"
          busy={busy}
          error={saveError}
          onConfirm={save}
          onCancel={() => setAsking(null)}
        >
          <Typography variant="body2">
            Every user&apos;s notices go out through this service, so saving it takes your password.
          </Typography>
        </PasswordDialog>
      ) : null}
      <ConfirmDialog
        open={asking === 'remove'}
        title={`Remove the ${name} service`}
        message={`Its settings and its ${secretName(kind)} are deleted, and no notice goes out through it until it is saved again. Each user's ${kind === 'email' ? 'email address' : 'Telegram chat'} stays saved.`}
        confirmText="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setAsking(null)}
      />
    </Paper>
  );
}
