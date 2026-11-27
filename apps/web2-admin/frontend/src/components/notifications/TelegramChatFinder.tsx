import { useState } from 'react';
import { Alert, Box, Button, Link, Stack, Typography } from '@mui/material';
import {
  NOTICE_SERVICE_NOT_SAVED_ERROR,
  TELEGRAM_CHAT_CODE_SECONDS,
  TELEGRAM_CODE_NOT_STARTED_ERROR,
  telegramStartLink,
  type TelegramBot,
  type TelegramChat,
  type TelegramChatKind,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatDateTime } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { ApiError } from '../../http';
import { ValueField } from '../ValueField';

/** What a chat's kind reads as once Find my chat found it. */
const CHAT_KIND_NAMES: Readonly<Record<TelegramChatKind, string>> = {
  private: 'Private chat',
  group: 'Group',
  supergroup: 'Group',
  channel: 'Channel',
};

/** How a found chat reads: its name, its kind and its id. */
export function chatLabel(chat: TelegramChat): string {
  return `${chat.name === '' ? 'No name' : chat.name} · ${CHAT_KIND_NAMES[chat.kind]} · ${chat.id}`;
}

/**
 * The command that sends the code from a group the bot is in. Telegram hands a bot in a group the commands addressed
 * to it, so the code goes after `/start@` and the bot's name, in one message; a plain message stays with the group.
 * The package's `telegramTextSendsCode` reads this form.
 */
export function groupCommand(bot: TelegramBot, code: string): string {
  return `/start@${bot.username} ${code}`;
}

/** The code shown to be sent, with the bot it goes to. */
interface Code {
  code: string;
  expiresAt: string | null;
  bot: TelegramBot;
}

/** What the last press came to, as a line under the buttons. */
type Note = { severity: 'success' | 'info' | 'error'; text: string };

/**
 * Find my chat, under My Telegram chat: it starts a code, shows it with the bot to send it to and the three ways to
 * send it, from the user's own chat, a group the bot is in or a channel it administers, and I sent it asks the admin
 * for the chat that sent it. The chat found fills in the field, through `onChat`, for the user to save behind their
 * password. It lists no other chat. `docs/architecture/notifications.md`, "Finding a Telegram chat".
 */
export function TelegramChatFinder({
  canFind,
  cannotFind,
  disabled,
  onChat,
  onReload,
}: {
  /** Whether the Telegram service is saved, with its token, and the admin can open it. */
  canFind: boolean;
  /** Why Find my chat is off while `canFind` is false. */
  cannotFind: string | null;
  disabled: boolean;
  onChat: (chat: TelegramChat) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<Code | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  /** A refusal of either route, as the note says it; a service removed meanwhile reads the page again. */
  const refused = (e: unknown, fallback: string) => {
    setNote({ severity: 'error', text: errorMessage(e, fallback) });
    if (e instanceof ApiError && e.code === NOTICE_SERVICE_NOT_SAVED_ERROR) onReload();
  };

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      const answer = await api.startMyTelegramCode();
      if (answer.code !== null && answer.bot !== null) {
        setCode({ code: answer.code, expiresAt: answer.expiresAt, bot: answer.bot });
      } else {
        setCode(null);
        setNote({
          severity: 'error',
          text: `The bot could not be read: ${answer.error ?? 'Telegram gave no answer.'}`,
        });
      }
    } catch (e: unknown) {
      setCode(null);
      refused(e, 'No code could be started.');
    } finally {
      setBusy(false);
    }
  };

  const look = async () => {
    setBusy(true);
    setNote(null);
    try {
      const answer = await api.findMyTelegramChat();
      if (answer.chat !== null) {
        onChat(answer.chat);
        setCode(null);
        setNote({
          severity: 'success',
          text: `Found ${chatLabel(answer.chat)}. Save it to have your notices go there.`,
        });
      } else if (answer.error !== null) {
        setNote({ severity: 'error', text: `Telegram could not be asked: ${answer.error}` });
      } else {
        setNote({
          severity: 'info',
          text: "None of the bot's latest messages holds your code yet. Send it in one of the ways above, then press I sent it again.",
        });
      }
    } catch (e: unknown) {
      if (e instanceof ApiError && e.code === TELEGRAM_CODE_NOT_STARTED_ERROR) setCode(null);
      refused(e, 'Your chat could not be looked for.');
    } finally {
      setBusy(false);
    }
  };

  const holds = code?.expiresAt
    ? `It holds until ${formatDateTime(code.expiresAt)}.`
    : `It holds for ${TELEGRAM_CHAT_CODE_SECONDS / 60} minutes.`;

  return (
    <Stack spacing={1}>
      <Box>
        <Button variant="outlined" disabled={disabled || busy || !canFind} onClick={() => void start()}>
          Find my chat
        </Button>
      </Box>
      {!canFind && cannotFind ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {cannotFind}
        </Typography>
      ) : null}
      {code ? (
        <Box
          role="group"
          aria-labelledby="notifications-telegram-code-title"
          sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover', display: 'grid', gap: 1.5 }}
        >
          <Typography id="notifications-telegram-code-title" variant="subtitle2" component="h4">
            Send your code to the bot
          </Typography>
          <Typography variant="body2">
            {`Send it from the chat your notices are to go to, in the way that chat takes. ${holds} A new code replaces it.`}
          </Typography>
          <ValueField label="Your code" value={code.code} />
          <Box component="ol" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 1 }}>
            <Typography component="li" variant="body2">
              <strong>Your own chat with the bot:</strong> open{' '}
              <Link href={telegramStartLink(code.bot.username, code.code)} target="_blank" rel="noopener noreferrer">
                {`${code.bot.name} (@${code.bot.username})`}
              </Link>{' '}
              and press Start.
            </Typography>
            <Typography component="li" variant="body2">
              <strong>A group the bot is in:</strong> send this as one message in the group. A plain message there stays
              with the group.
              <Box sx={{ mt: 1 }}>
                <ValueField label="Group command" value={groupCommand(code.bot, code.code)} />
              </Box>
            </Typography>
            <Typography component="li" variant="body2">
              <strong>A channel the bot is an administrator of:</strong> post the code there.
            </Typography>
          </Box>
          <Box>
            <Button variant="contained" disabled={disabled || busy} onClick={() => void look()}>
              I sent it
            </Button>
          </Box>
        </Box>
      ) : null}
      {note ? (
        <Alert severity={note.severity} onClose={() => setNote(null)}>
          {note.text}
        </Alert>
      ) : null}
    </Stack>
  );
}
