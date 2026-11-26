import type { ReactElement, ReactNode } from 'react';
import { Box, Link, Typography } from '@mui/material';
import {
  EMAIL_RECIPIENTS_MAX,
  NOTIFICATION_CHANNEL_NAMES,
  type NotificationChannelKind,
} from '@streaming-monorepo/web2-admin-common';

import { monoFont } from '../../theme/createAdminTheme';

/** Something to type or to look for, as it is written. */
function Literal({ children }: { children: ReactNode }) {
  return (
    <Box component="code" sx={{ fontFamily: monoFont, fontSize: '0.95em', overflowWrap: 'anywhere' }}>
      {children}
    </Box>
  );
}

/** A page of the service's own, opened in a new tab. */
function Outside({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
      {children}
    </Box>
  );
}

function Step({ children }: { children: ReactNode }) {
  return (
    <Typography component="li" variant="body2" sx={{ mb: 0.75 }}>
      {children}
    </Typography>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
      {children}
    </Typography>
  );
}

function EmailSetup() {
  return (
    <Steps>
      <Step>
        In <Outside href="https://app.brevo.com">Brevo</Outside>, generate an API key under SMTP &amp; API. It starts
        with <Literal>xkeysib-</Literal>: an SMTP key does not work here.
      </Step>
      <Step>
        Give the mails a sender Brevo sends for. Authenticate your domain under Senders, Domains &amp; Dedicated IPs,
        with the DNS records Brevo gives, and any address of it can send. Without access to the domain&apos;s DNS, add
        one address as a sender and confirm it from its mailbox.
      </Step>
      <Step>
        Under Security, Authorised IPs, authorise the address the admin&apos;s host sends from. Brevo refuses a key used
        from an address it does not know.
      </Step>
      <Step>
        {`Enter the API key, the sender address, a sender name if you want one, and the recipients, ${EMAIL_RECIPIENTS_MAX} at most. Save, then press Send a test notice.`}
      </Step>
    </Steps>
  );
}

function SlackSetup() {
  return (
    <>
      <Steps>
        <Step>
          At <Outside href="https://api.slack.com/apps">api.slack.com/apps</Outside>, press Create New App, choose From
          scratch, name the app, for example Stream alerts, and pick your workspace.
        </Step>
        <Step>Under Incoming Webhooks, switch Activate Incoming Webhooks on.</Step>
        <Step>
          Press Add New Webhook, choose the channel the notices go to and press Allow. Where the workspace approves
          apps, an admin approves it first.
        </Step>
        <Step>
          Copy the webhook&apos;s URL, which starts with <Literal>https://hooks.slack.com/services/</Literal>, into
          Webhook URL. Save, then press Send a test notice.
        </Step>
      </Steps>
      <Note>
        A Workflow Builder webhook, whose URL holds <Literal>/triggers/</Literal>, is not taken. Each Slack channel
        needs a webhook of its own.
      </Note>
    </>
  );
}

function TelegramSetup() {
  return (
    <>
      <Steps>
        <Step>
          In Telegram, open <Outside href="https://t.me/BotFather">BotFather</Outside> and send{' '}
          <Literal>/newbot</Literal>. Give the bot a name, then a username that ends in bot. BotFather answers with the
          bot&apos;s token, which looks like <Literal>123456789:AAH…</Literal>.
        </Step>
        <Step>
          Open the new bot from the link in BotFather&apos;s answer and press Start. For a group, add the bot to it and
          send <Literal>/start@yourbot</Literal> there, with the bot&apos;s username in place of yourbot. For a public
          channel, make the bot an administrator: the chat id is then the channel&apos;s name, such as{' '}
          <Literal>@channelname</Literal>, and the next step is not needed.
        </Step>
        <Step>
          Enter the token as the Bot token, press Find chat id and pick the chat: it lists the chats that wrote to the
          bot in the last day, a private chat by your name.
        </Step>
        <Step>Save, then press Send a test notice.</Step>
      </Steps>
      <Note>
        If Find chat id lists no chat, send the bot a message and press it again: Telegram keeps a bot&apos;s messages
        for a day. <Literal>Unauthorized</Literal> means the token is wrong.
      </Note>
    </>
  );
}

/** How to set each channel up: what to make at its service, then what to enter on its card. */
const SETUP: Readonly<Record<NotificationChannelKind, () => ReactElement>> = {
  email: EmailSetup,
  slack: SlackSetup,
  telegram: TelegramSetup,
};

/**
 * The steps to set a channel up, which its card shows under the channel's name while the ? beside the name is
 * pressed. `id` is what the ? names as the part it opens.
 */
export function ChannelSetup({ kind, id }: { kind: NotificationChannelKind; id: string }) {
  const Setup = SETUP[kind];
  return (
    <Box
      id={id}
      role="region"
      aria-labelledby={`${id}-title`}
      sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover', display: 'grid', gap: 1 }}
    >
      <Typography id={`${id}-title`} variant="subtitle2" component="h3">
        {`How to set up ${NOTIFICATION_CHANNEL_NAMES[kind]}`}
      </Typography>
      <Setup />
    </Box>
  );
}
