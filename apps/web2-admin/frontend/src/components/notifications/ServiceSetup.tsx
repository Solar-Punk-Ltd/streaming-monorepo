import type { ReactElement, ReactNode } from 'react';
import { Box, Link, Typography } from '@mui/material';
import { NOTICE_SERVICE_NAMES, type NoticeServiceKind } from '@streaming-monorepo/web2-admin-common';

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
        Enter the API key, the sender address and a sender name if you want one, and Save. Each user then enters their
        own email address under My notifications and sends themselves a test notice.
      </Step>
    </Steps>
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
        <Step>Enter the token as the Bot token, and Save.</Step>
        <Step>
          Each user then presses Find my chat under My notifications, which links their own chat with the bot, and sends
          themselves a test notice.
        </Step>
      </Steps>
      <Note>
        For notices in a group, add the bot to the group. For a channel, make the bot an administrator of it. The user
        whose notices go there then finds it with Find my chat.
      </Note>
    </>
  );
}

/** How to set each service up: what to make at the service, then what to enter on its card. */
const SETUP: Readonly<Record<NoticeServiceKind, () => ReactElement>> = {
  email: EmailSetup,
  telegram: TelegramSetup,
};

/**
 * The steps to set a service up, which its card shows under the service's name while the ? beside the name is
 * pressed. `id` is what the ? names as the part it opens.
 */
export function ServiceSetup({ kind, id }: { kind: NoticeServiceKind; id: string }) {
  const Setup = SETUP[kind];
  return (
    <Box
      id={id}
      role="region"
      aria-labelledby={`${id}-title`}
      sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover', display: 'grid', gap: 1 }}
    >
      <Typography id={`${id}-title`} variant="subtitle2" component="h4">
        {`How to set up ${NOTICE_SERVICE_NAMES[kind]}`}
      </Typography>
      <Setup />
    </Box>
  );
}
