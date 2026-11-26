import { useState } from 'react';
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material';
import { channelSecretProblem, type TelegramChat, type TelegramChatKind } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';

/** What a chat's kind reads as in the list Find chat id shows. */
const CHAT_KIND_NAMES: Readonly<Record<TelegramChatKind, string>> = {
  private: 'Private chat',
  group: 'Group',
  supergroup: 'Group',
  channel: 'Channel',
};

/** How a chat reads in that list: its name, its kind and its id. */
export function chatLabel(chat: TelegramChat): string {
  return `${chat.name === '' ? 'No name' : chat.name} · ${CHAT_KIND_NAMES[chat.kind]} · ${chat.id}`;
}

/** What the last Find chat id came to: the chats it found, or why none came. */
type Found = { chats: TelegramChat[] } | { error: string };

/**
 * The Telegram card's chat id: its field, and Find chat id, which asks the admin for the chats that wrote to the bot
 * within the last day, with the bot token typed above it or, with none typed, the saved one, and fills in the chat
 * picked. Picking one changes the form alone: Save keeps it.
 */
export function TelegramChatField({
  chatId,
  secret,
  saved,
  disabled,
  onChatId,
}: {
  chatId: string;
  /** The bot token as typed. Empty uses the saved one. */
  secret: string;
  /** Whether the channel has a saved token. */
  saved: boolean;
  disabled: boolean;
  onChatId: (chatId: string) => void;
}) {
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const typed = secret.trim();
  const canFind = typed === '' ? saved : channelSecretProblem('telegram', typed) === null;

  const find = async () => {
    setFinding(true);
    setFound(null);
    try {
      const answer = await api.findTelegramChats(typed === '' ? null : typed);
      setFound(answer.error === null ? { chats: answer.chats } : { error: answer.error });
    } catch (e: unknown) {
      setFound({ error: errorMessage(e, "The admin's answer could not be read.") });
    } finally {
      setFinding(false);
    }
  };

  const pick = (chat: TelegramChat) => {
    onChatId(chat.id);
    setFound(null);
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          id="notifications-telegram-chat-id"
          label="Chat id"
          value={chatId}
          onChange={(event) => onChatId(event.target.value)}
          helperText="The chat's number, such as -1001234567890 for a group, or a public channel's name, such as @channelname."
          size="small"
          sx={{ flexGrow: 1, maxWidth: 480 }}
        />
        <Button
          variant="outlined"
          disabled={disabled || finding || !canFind}
          onClick={() => void find()}
          sx={{ whiteSpace: 'nowrap', mt: 0.25 }}
        >
          Find chat id
        </Button>
      </Stack>
      {typed === '' && !saved ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Enter the bot token, then Find chat id lists the chats that wrote to the bot.
        </Typography>
      ) : null}
      {found !== null && 'error' in found ? (
        <Alert severity="error" onClose={() => setFound(null)}>
          {`The bot's chats could not be read: ${found.error}`}
        </Alert>
      ) : null}
      {found !== null && 'chats' in found && found.chats.length === 0 ? (
        <Alert severity="info" onClose={() => setFound(null)}>
          No chat wrote to the bot in the last day. Press Start in your chat with the bot, or send /start@yourbot in the
          group, then press Find chat id again.
        </Alert>
      ) : null}
      {found !== null && 'chats' in found && found.chats.length > 0 ? (
        <Box role="group" aria-labelledby="notifications-telegram-chats-title">
          <Typography id="notifications-telegram-chats-title" variant="body2" sx={{ mb: 0.5 }}>
            Chats that wrote to the bot in the last day. Pick the one the notices go to.
          </Typography>
          <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
            {found.chats.map((chat) => (
              <Button key={chat.id} size="small" onClick={() => pick(chat)} sx={{ textTransform: 'none' }}>
                {chatLabel(chat)}
              </Button>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Stack>
  );
}
