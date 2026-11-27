import { useState } from 'react';
import { Alert, Button, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import {
  destinationAddressProblem,
  NOTICE_DESTINATION_NAMES,
  NOTICE_DESTINATION_NOT_SAVED_ERROR,
  NOTICE_SERVICE_NAMES,
  NOTICE_SERVICE_NOT_SAVED_ERROR,
  storedDestinationAddress,
  type MyDestination,
  type NoticeServiceKind,
  type NoticeServiceView,
  type NoticesView,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { ApiError } from '../../http';
import { ConfirmDialog } from '../ConfirmDialog';
import { PasswordDialog } from '../funding/PasswordDialog';
import { noticeCount } from './noticeText';
import { TelegramChatFinder } from './TelegramChatFinder';

/** What became of the last test notice asked for on this card, as the card says it. */
type TestOutcome = { severity: 'success' | 'warning' | 'error'; text: string };

/** Each destination's card title, as the page names it. */
export const DESTINATION_TITLES: Readonly<Record<NoticeServiceKind, string>> = {
  email: 'My email address',
  telegram: 'My Telegram chat',
};

/** What a dialog calls each destination, after its verb: "Save my email address". */
const DIALOG_NAMES: Readonly<Record<NoticeServiceKind, string>> = {
  email: 'my email address',
  telegram: 'my Telegram chat',
};

/** The line under each destination's field. */
const FIELD_HELP: Readonly<Record<NoticeServiceKind, string>> = {
  email: 'Your notices are mailed here.',
  telegram:
    "Your chat's number, a group's, such as -1001234567890, or a public channel's name, such as @channelname. Find my chat fills it in.",
};

/** What the API said of a write, for a card to show: its sentence, and whether the page should read the view again. */
function failure(e: unknown, fallback: string): { text: string; reload: boolean } {
  return {
    text: errorMessage(e, fallback),
    reload:
      e instanceof ApiError &&
      (e.code === NOTICE_DESTINATION_NOT_SAVED_ERROR || e.code === NOTICE_SERVICE_NOT_SAVED_ERROR),
  };
}

/** How the destination stands: when it was saved, its last notice, why that failed, what waits for it, its last test. */
function DestinationState({ destination, now }: { destination: MyDestination; now: number }) {
  if (destination.address === null) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Not saved yet.
      </Typography>
    );
  }
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2">
        {destination.savedAt ? `Saved ${formatAgo(destination.savedAt, now)}.` : 'Saved.'}
      </Typography>
      <Typography variant="body2">
        {destination.lastSentAt ? `Last notice sent ${formatAgo(destination.lastSentAt, now)}.` : 'No notice sent yet.'}
      </Typography>
      {destination.lastError ? (
        <Typography variant="body2" sx={{ color: 'error.main' }}>
          {`The last notice could not be sent${destination.lastErrorAt ? ` ${formatAgo(destination.lastErrorAt, now)}` : ''}: ${destination.lastError}`}
        </Typography>
      ) : null}
      {destination.waiting > 0 ? (
        <Typography variant="body2">{`${noticeCount(destination.waiting)} ${destination.waiting === 1 ? 'waits' : 'wait'} for it.`}</Typography>
      ) : null}
      {destination.lastTestAt ? (
        <Typography variant="body2" sx={{ color: destination.lastTestError ? 'error.main' : 'text.secondary' }}>
          {destination.lastTestError
            ? `The last test could not be sent ${formatAgo(destination.lastTestAt, now)}: ${destination.lastTestError}`
            : `The last test went out ${formatAgo(destination.lastTestAt, now)}.`}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** Why nothing goes out to the destination for now, because of its service, or null while the service is on. */
function serviceLine(service: NoticeServiceView | null, kind: NoticeServiceKind): string | null {
  const name = NOTICE_SERVICE_NAMES[kind];
  if (service === null || !service.saved) {
    return `The ${name} service is not set up yet, so nothing goes out here until an admin sets it up.`;
  }
  if (!service.enabled) {
    return `The ${name} service is switched off, so nothing goes out here until an admin switches it on.`;
  }
  return null;
}

/**
 * One of the signed-in user's destinations: their email address or their Telegram chat. It shows how it stands, its
 * on/off switch and its field, with Save behind the user's password, Undo changes, Send me a test notice and Remove,
 * which ask for none. The Telegram card has Find my chat under its field. The field as typed, `draft`, is the page's;
 * null follows the saved address. Nobody else reads it.
 */
export function DestinationCard({
  destination,
  service,
  available,
  draft,
  onDraft,
  onView,
  onReload,
}: {
  destination: MyDestination;
  /** The service it is on, as the view has it. */
  service: NoticeServiceView | null;
  /** Whether a notice can be sent at all: the admin has its `BRAND_WALLET_SECRET`. */
  available: boolean;
  draft: string | null;
  onDraft: (next: string | null) => void;
  onView: (next: NoticesView) => void;
  onReload: () => void;
}) {
  const { kind } = destination;
  const title = DESTINATION_TITLES[kind];
  const fieldName = NOTICE_DESTINATION_NAMES[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'save' | 'remove' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<TestOutcome | null>(null);

  const saved = destination.address !== null;
  const serviceSaved = service !== null && service.saved;
  const shown = draft ?? destination.address ?? '';
  const problem = draft === null ? null : destinationAddressProblem(kind, shown);
  const changed = draft !== null && storedDestinationAddress(kind, shown) !== (destination.address ?? '');
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
      onView(await api.saveMyDestination(kind, password, storedDestinationAddress(kind, shown)));
      onDraft(null);
      setAsking(null);
      setTest(null);
    } catch (e: unknown) {
      setSaveError(errorMessage(e, 'Your destination could not be saved.'));
      if (e instanceof ApiError && e.code === 'invalid_credentials') return 'wrong-password';
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const remove = async () => {
    if (await write(() => api.removeMyDestination(kind), 'Your destination could not be removed.')) {
      onDraft(null);
      setTest(null);
    }
    setAsking(null);
  };

  const sendTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const answer = await api.sendMyTestNotice(kind);
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

  const off = available ? serviceLine(service, kind) : null;

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-section>
      <Stack spacing={2}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={saved && destination.enabled}
                disabled={!saved || busy}
                onChange={(event) =>
                  void write(
                    () => api.setMyDestinationEnabled(kind, event.target.checked),
                    'Your destination could not be switched.',
                  )
                }
              />
            }
            label={`${fieldName} on`}
          />
        </Stack>
        <DestinationState destination={destination} now={now} />
        {off ? (
          <Typography variant="body2" sx={{ color: 'warning.main' }}>
            {off}
          </Typography>
        ) : null}
        {error ? (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        <TextField
          id={`notifications-my-${kind}`}
          label={fieldName}
          value={shown}
          onChange={(event) => onDraft(event.target.value)}
          helperText={FIELD_HELP[kind]}
          error={problem !== null}
          size="small"
          sx={{ maxWidth: 480 }}
          slotProps={{ htmlInput: { autoComplete: kind === 'email' ? 'email' : 'off' } }}
        />
        {problem ? (
          <Typography variant="caption" sx={{ color: 'error.main' }}>
            {problem}
          </Typography>
        ) : null}
        {kind === 'telegram' ? (
          <TelegramChatFinder
            canFind={available && serviceSaved}
            cannotFind={available ? 'Find my chat works once an admin has set up the Telegram service.' : null}
            disabled={busy}
            onChat={(chat) => onDraft(chat.id)}
            onReload={onReload}
          />
        ) : null}
        {test ? (
          <Alert severity={test.severity} onClose={() => setTest(null)}>
            {test.text}
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            disabled={busy || !changed || problem !== null}
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
          <Button disabled={!saved || !serviceSaved || !available || busy} onClick={() => void sendTest()}>
            Send me a test notice
          </Button>
          <Button color="error" disabled={!saved || busy} onClick={() => setAsking('remove')}>
            Remove
          </Button>
        </Stack>
      </Stack>
      {asking === 'save' ? (
        <PasswordDialog
          title={`Save ${DIALOG_NAMES[kind]}`}
          confirmText="Save"
          busy={busy}
          error={saveError}
          onConfirm={save}
          onCancel={() => setAsking(null)}
        >
          <Typography variant="body2">Your notices go here, so saving it takes your password.</Typography>
        </PasswordDialog>
      ) : null}
      <ConfirmDialog
        open={asking === 'remove'}
        title={`Remove ${DIALOG_NAMES[kind]}`}
        message="Your notices stop going here, and the notices that wait for it are dropped. Your ticks stay."
        confirmText="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setAsking(null)}
      />
    </Paper>
  );
}
