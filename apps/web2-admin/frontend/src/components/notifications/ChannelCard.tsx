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
import DeleteIcon from '@mui/icons-material/Delete';
import {
  EMAIL_PROVIDER_KINDS,
  EMAIL_PROVIDER_NAMES,
  EMAIL_RECIPIENTS_MAX,
  NOTIFICATION_CHANNEL_NAMES,
  NOTIFICATION_CHANNEL_NOT_SAVED_ERROR,
  NOTIFICATION_SECRET_NAMES,
  type EmailProviderKind,
  type NotificationChannelView,
  type NotificationsView,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { ApiError } from '../../http';
import { ConfirmDialog } from '../ConfirmDialog';
import { PasswordDialog } from '../funding/PasswordDialog';
import {
  draftChanged,
  draftOf,
  draftProblems,
  draftRequest,
  recipientLinesRefused,
  secretName,
  type ChannelDraft,
} from './channelDraft';

/** What became of the last test notice asked for on this page, as the card says it. */
type TestOutcome = { severity: 'success' | 'warning' | 'error'; text: string };

/** What the API said of a write, for a card to show: its sentence, and whether the page should read the view again. */
function failure(e: unknown, fallback: string): { text: string; reload: boolean } {
  return {
    text: errorMessage(e, fallback),
    reload: e instanceof ApiError && e.code === NOTIFICATION_CHANNEL_NOT_SAVED_ERROR,
  };
}

/** How the channel stands: who saved it, its last notice, why that failed, what waits for it, and its last test. */
function ChannelState({ channel, now }: { channel: NotificationChannelView; now: number }) {
  if (!channel.saved) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Not saved yet.
      </Typography>
    );
  }
  const waiting =
    channel.waiting === 1 ? '1 notice waits for this channel.' : `${channel.waiting} notices wait for this channel.`;
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2">
        {channel.savedAt ? `Saved by ${channel.savedBy ?? 'someone'}, ${formatAgo(channel.savedAt, now)}.` : 'Saved.'}
      </Typography>
      <Typography variant="body2">
        {channel.lastSentAt ? `Last notice sent ${formatAgo(channel.lastSentAt, now)}.` : 'No notice sent yet.'}
      </Typography>
      {channel.lastError ? (
        <Typography variant="body2" sx={{ color: 'error.main' }}>
          {`The last notice could not be sent${channel.lastErrorAt ? ` ${formatAgo(channel.lastErrorAt, now)}` : ''}: ${channel.lastError}`}
        </Typography>
      ) : null}
      {channel.waiting > 0 ? <Typography variant="body2">{waiting}</Typography> : null}
      {channel.lastTestAt ? (
        <Typography variant="body2" sx={{ color: channel.lastTestError ? 'error.main' : 'text.secondary' }}>
          {channel.lastTestError
            ? `The last test could not be sent ${formatAgo(channel.lastTestAt, now)}: ${channel.lastTestError}`
            : `The last test went out ${formatAgo(channel.lastTestAt, now)}.`}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** The email channel's own fields: the service, the sender, and a line per recipient with Add and Remove. */
function EmailFields({ draft, onDraft }: { draft: ChannelDraft; onDraft: (next: ChannelDraft) => void }) {
  const refused = recipientLinesRefused(draft.recipients);
  return (
    <Stack spacing={2}>
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
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {`A notice is mailed to these addresses, ${EMAIL_RECIPIENTS_MAX} at most, all named in the one mail.`}
      </Typography>
      {draft.recipients.map((line, index) => (
        // A line has no id of its own: an address may be typed twice, and its place is what Remove names.
        <Stack key={`recipient-${index + 1}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField
            id={`notifications-email-recipient-${index + 1}`}
            label={`Recipient ${index + 1}`}
            value={line}
            onChange={(event) =>
              onDraft({
                ...draft,
                recipients: draft.recipients.map((each, at) => (at === index ? event.target.value : each)),
              })
            }
            error={refused[index]}
            size="small"
            sx={{ flexGrow: 1, maxWidth: 480 }}
          />
          <Tooltip title="Remove">
            <IconButton
              aria-label={`Remove recipient ${index + 1}`}
              onClick={() => onDraft({ ...draft, recipients: draft.recipients.filter((_each, at) => at !== index) })}
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      ))}
      <Box>
        <Button
          disabled={draft.recipients.length >= EMAIL_RECIPIENTS_MAX}
          onClick={() => onDraft({ ...draft, recipients: [...draft.recipients, ''] })}
        >
          Add recipient
        </Button>
      </Box>
    </Stack>
  );
}

/**
 * One channel on the Notifications page: how it stands, its on/off switch, its form, Save behind the password, Undo
 * changes, Send a test notice and Remove. The secret is write-only: the field starts empty, says whether one is set,
 * and left empty keeps it. The form as typed, `draft`, is the page's; null follows the saved channel.
 */
export function ChannelCard({
  channel,
  available,
  draft,
  onDraft,
  onView,
  onReload,
}: {
  channel: NotificationChannelView;
  /** Whether a channel can be saved: the admin has its `BRAND_WALLET_SECRET`. */
  available: boolean;
  draft: ChannelDraft | null;
  onDraft: (next: ChannelDraft | null) => void;
  onView: (next: NotificationsView) => void;
  onReload: () => void;
}) {
  const { kind } = channel;
  const name = NOTIFICATION_CHANNEL_NAMES[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'save' | 'remove' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<TestOutcome | null>(null);

  const shown = draft ?? draftOf(channel);
  const problems = draft === null ? [] : draftProblems(kind, shown, channel.saved);
  const changed = draft !== null && draftChanged(channel, shown);
  const now = Date.now();

  /** Runs one write of the card, one at a time, and takes its answer as the page's view. */
  const write = async (run: () => Promise<NotificationsView>, fallback: string) => {
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
      const { settings, secret } = draftRequest(kind, shown);
      onView(await api.saveNotificationChannel(kind, password, settings, secret));
      onDraft(null);
      setAsking(null);
    } catch (e: unknown) {
      setSaveError(errorMessage(e, 'The channel could not be saved.'));
      if (e instanceof ApiError && e.code === 'invalid_credentials') return 'wrong-password';
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const remove = async () => {
    if (await write(() => api.removeNotificationChannel(kind), 'The channel could not be removed.')) {
      onDraft(null);
      setTest(null);
    }
    setAsking(null);
  };

  const sendTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const answer = await api.sendNotificationTest(kind);
      onView(answer.view);
      setTest(
        answer.sent
          ? { severity: 'success', text: 'The test notice went out.' }
          : {
              severity: 'error',
              text: `The test notice could not be sent: ${answer.error ?? 'the service said no more.'}`,
            },
      );
    } catch (e: unknown) {
      const { text, reload } = failure(e, 'The test notice could not be sent.');
      setTest({ severity: e instanceof ApiError && e.status === 429 ? 'warning' : 'error', text });
      if (reload) onReload();
    } finally {
      setBusy(false);
    }
  };

  const secretLabel = NOTIFICATION_SECRET_NAMES[kind];

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-section>
      <Stack spacing={2}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="h6" component="h2">
            {name}
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={channel.saved && channel.enabled}
                disabled={!channel.saved || busy}
                onChange={(event) =>
                  void write(
                    () => api.setNotificationChannelEnabled(kind, event.target.checked),
                    'The channel could not be switched.',
                  )
                }
              />
            }
            label={`${name} on`}
          />
        </Stack>
        <ChannelState channel={channel} now={now} />
        {error ? (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {kind === 'email' ? <EmailFields draft={shown} onDraft={onDraft} /> : null}
        {kind === 'telegram' ? (
          <TextField
            id="notifications-telegram-chat-id"
            label="Chat id"
            value={shown.chatId}
            onChange={(event) => onDraft({ ...shown, chatId: event.target.value })}
            helperText="The group's number, such as -1001234567890, or a public channel's name, such as @channelname."
            size="small"
            sx={{ maxWidth: 480 }}
          />
        ) : null}
        <TextField
          id={`notifications-${kind}-secret`}
          label={secretLabel}
          type="password"
          autoComplete="new-password"
          value={shown.secret}
          onChange={(event) => onDraft({ ...shown, secret: event.target.value })}
          helperText={channel.saved ? 'Set. Leave the field empty to keep it.' : 'Not set.'}
          size="small"
          sx={{ maxWidth: 480 }}
        />
        {problems.map((problem) => (
          <Typography key={problem} variant="caption" sx={{ color: 'error.main' }}>
            {problem}
          </Typography>
        ))}
        {test ? (
          <Alert severity={test.severity} onClose={() => setTest(null)}>
            {test.text}
          </Alert>
        ) : null}
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
          <Button disabled={!channel.saved || busy} onClick={() => void sendTest()}>
            Send a test notice
          </Button>
          <Button color="error" disabled={!channel.saved || busy} onClick={() => setAsking('remove')}>
            Remove
          </Button>
        </Stack>
      </Stack>
      {asking === 'save' ? (
        <PasswordDialog
          title={`Save the ${name} channel`}
          confirmText="Save"
          busy={busy}
          error={saveError}
          onConfirm={save}
          onCancel={() => setAsking(null)}
        >
          <Typography variant="body2">
            The alerts and warnings go out on this channel, so saving it takes your password.
          </Typography>
        </PasswordDialog>
      ) : null}
      <ConfirmDialog
        open={asking === 'remove'}
        title={`Remove the ${name} channel`}
        message={`Its settings and its ${secretName(kind)} are deleted, and no notice goes out on it until it is saved again.`}
        confirmText="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setAsking(null)}
      />
    </Paper>
  );
}
