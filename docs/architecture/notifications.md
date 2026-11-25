# Notifications from the admin

This is a concepts page. It explains how the admin tells people what needs their attention: the
notice, the channels it goes out on, how a brand sets those up, what counts as notified, and the
rules that keep the channels' secrets and the outgoing calls safe.

The admin's stamp auto top-up is the sender today: its alerts and warnings
([funding.md](funding.md#auto-top-up)). It decides what a notice says and when one goes out. The
notification module decides nothing of that. It takes a notice and delivers it.

## The notice and the channels

A **notice** is a title of one line and a plain text. It reads the same on every channel.

A **channel** is one way a notice reaches people:

| Channel  | The service it calls                                  | Its settings                                           | Its secret            | How a notice reads there                               |
| -------- | ----------------------------------------------------- | ------------------------------------------------------ | --------------------- | ------------------------------------------------------ |
| Email    | Brevo's API, `api.brevo.com`                          | the sender's address and name, and the recipients      | the service's API key | A mail: the title is the subject, the text is the body |
| Slack    | an incoming webhook of a Slack app, `hooks.slack.com` | none: Slack fixes the channel when the webhook is made | the webhook's URL     | A message: the title in bold, then the text            |
| Telegram | the Bot API's `sendMessage`, `api.telegram.org`       | the chat's id                                          | the bot's token       | A message: the title, then the text                    |

- The text goes out as plain text. On Slack `&`, `<` and `>` are escaped, and Telegram is sent no
  parse mode, so a stamp's or a node's name never formats a message, makes a link or mentions
  anyone.
- A long notice goes as several messages, cut at line breaks and sent in order: over 4000
  characters on Slack, counted once its text is escaped, and over 4096 on Telegram. The channel
  took the notice once it took every message. When a later message fails, the notice failed on
  that channel, and its next try sends it whole again.
- Email recipients are 20 at most, and every recipient is named in the one mail.

**Email providers.** The email channel sends through an email provider: one small interface that
takes a sender, the recipients, a subject and a text. Brevo is the provider there is. Another
email service is one more provider, chosen in the email channel's settings; the channel and
everything above it stay as they are.

The module is the shared package `packages/notifications`. It holds the notice, the channels, the
email provider and the checks of each channel's settings. It keeps no settings and knows no stamp.
The admin keeps the settings, decides which notices to send, and records how each send went.

## The Notifications page

One set of channels serves the whole admin, and every signed-in user can see and change it.

- **Save** takes a channel's settings and its secret and asks for your password, as a send from
  the brand wallet does: a changed channel changes where the alerts go. A channel saved for the
  first time starts on. Saving with the secret's field empty keeps the stored secret.
- **On and off** switches a saved channel with no password, as pausing a job does. Switching a
  channel off drops the notices that wait for it.
- **Send a test notice** sends one notice on a saved channel, on or off, that says who asked for
  it and when. One goes out a minute at most on a channel. A test counts in no rule.
- **Remove** deletes a channel with its secret.
- For each channel the page shows whether it is on, who saved it and when, when it last took a
  notice, why its last one failed, how many notices wait for it, and how its last test went.

Every notice goes out on every channel that is on. With no channel on, a notice shows only on the
page of whoever raised it: the Auto top-up tab for stamp auto top-up.

## Notified

- A notice is **notified** once one channel took it. Stamp auto top-up counts its day of notice
  from that moment ([funding.md](funding.md#from-alert-to-top-up)).
- When **no channel** took it, nothing is kept, each channel records why it failed, and the sender
  sends its notice again on its next run: for stamp auto top-up the next tick, 10 minutes later.
- When **some channels** took it and others failed, the notice waits for each channel that failed
  and is tried again there at every tick. It carries the time it was raised. A channel that took a
  notice never gets it twice.
- A waiting notice is dropped a day after it was raised, when its channel is switched off or
  removed, and when nothing it tells of stands any more: a warning that cleared, a top-up that was
  made.
- Nothing is tried twice within a tick. The channels are called side by side and each call ends
  after 10 seconds, so a slow service holds up neither the other channels nor the tick.

## The secrets

- A channel's secret is stored in the admin's database encrypted with AES-256-GCM, as the brand
  wallet's key is. The key is derived from `BRAND_WALLET_SECRET` with HKDF-SHA-256 under a label of
  its own, so it is another key than the one the brand wallet's key is under, and neither is in the
  database. Each stored secret records the version of its key.
- A stored secret opens only as the channel it was saved for.
- With `BRAND_WALLET_SECRET` unset no channel can be saved, and the page says so.
- No answer of the API holds a secret. The page shows that a channel has one, never what it is.
- No log line and no audit entry holds a secret or an address that was called: Telegram's address
  carries the bot's token, and Slack's is the secret itself. A failure is recorded as a sentence
  with the service's status and a short part of its answer, the secret cut out of it.
- A secret is opened for the one send that needs it.

## The outgoing calls

- Every call goes over HTTPS to a host fixed in the code: `api.brevo.com`, `hooks.slack.com` and
  `api.telegram.org`. A channel's settings name no host, and a Slack webhook's URL is taken only
  on Slack's host.
- No redirect is followed.
- A call ends after 10 seconds, and at most 16 KB of the answer are read.
- The admin host's outgoing traffic has to reach the hosts of the channels in use, on port 443.

## The API

Under `/api/notifications`, behind the session, the writes behind the same-site check as well.

| Route                                   | What it does                                                 |
| --------------------------------------- | ------------------------------------------------------------ |
| `GET /api/notifications`                | The page's view: every channel, saved or not                 |
| `PUT /api/notifications/channels/:kind` | Saves a channel, behind the password                         |
| `PUT …/channels/:kind/enabled`          | Switches a saved channel on or off                           |
| `POST …/channels/:kind/test`            | Sends a test notice, and answers whether the service took it |
| `DELETE …/channels/:kind`               | Removes a channel with its secret                            |

`:kind` is `email`, `slack` or `telegram`.

## Setting a channel up

[self-hosting.md](../self-hosting.md#notifications-from-the-admin) says what to create at each
service and what to enter on the page.
