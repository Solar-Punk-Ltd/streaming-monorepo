# Notifications from the admin

This is a concepts page. It explains how the admin tells people what needs their attention: the
notice, the topics a person picks from, the services a brand shares, each user's own destinations,
what counts as notified, and the rules that keep the secrets, each user's settings and the outgoing
calls safe.

The admin's stamp auto top-up is the sender today: its alerts and warnings, and the stamps it
watches without topping them up ([funding.md](funding.md#auto-top-up)). It decides what a notice
says, under which topic, and when one goes out. The notification module decides nothing of that. It
works out who gets which part of a notice and delivers each person theirs.

## Notices, topics, services and destinations

A **notice** is a title of one line and a plain text. It reads the same on every service.

A **topic** is what a notice is about, as a person picks what reaches them:

| Topic                        | It tells of                                                    | A user starts with it |
| ---------------------------- | -------------------------------------------------------------- | --------------------- |
| Top-ups coming up            | Top-ups of marked stamps a day ahead                           | ticked                |
| The brand wallet is low      | The brand wallet's xBZZ or xDAI under what the top-ups need    | ticked                |
| A top-up failed              | A due marked stamp that could not be topped up                 | ticked                |
| A marked stamp expired       | A marked stamp that ran out                                    | ticked                |
| Catalogue and archive stamps | The catalogue batch or an archive stamp, unmarked, running low | unticked              |
| Stage stamps                 | A stage's batch, unmarked, running low                         | unticked              |

A **service** is what a notice goes out through. One of each kind serves every user:

| Service  | It calls                                        | Its settings                                | Its secret            | How a notice reads there                               |
| -------- | ----------------------------------------------- | ------------------------------------------- | --------------------- | ------------------------------------------------------ |
| Email    | Brevo's API, `api.brevo.com`                    | the provider, the sender's address and name | the service's API key | A mail: the title is the subject, the text is the body |
| Telegram | the Bot API's `sendMessage`, `api.telegram.org` | none                                        | the bot's token       | A message: the title, then the text                    |

A **destination** is where one user's notices go on one service: their email address, or the id of
their Telegram chat with the bot. Each user saves their own.

- The text goes out as plain text. Telegram is sent no parse mode, so a stamp's or a node's name
  never formats a message, makes a link or mentions anyone.
- A notice over 4096 characters goes to Telegram as several messages, cut at line breaks and sent in
  order. The destination took the notice once it took every message. When a later message fails, the
  notice failed there, and its next try sends it whole again.
- A mail goes to one address. Two users' notices are two mails, and each names its own recipient
  alone.

**Email providers.** The email service sends through an email provider: one small interface that
takes a sender, a recipient, a subject and a text. Brevo is the provider there is. Another email
service is one more provider, chosen in the email service's settings; everything above it stays as
it is.

The module is the shared package `packages/notifications`. It holds the notice, the channel a
notice reaches one destination on, the email provider, and the checks of a service's settings and
of a destination. It keeps no settings and knows no stamp and no user. The admin keeps the settings,
decides which notices to send, works out who gets them, and records how each send went.

## The Notifications page

The page has two parts: the services, which the brand shares, and My notifications, which are the
signed-in user's own.

### Shared services

A user with the admin role saves, switches and removes the services. The Access page gives that
role, which also manages the users. Every other user sees of each service whether it is set up and
on.

- **Save** takes a service's settings and its secret and asks for your password, as a send from the
  brand wallet does. A service saved for the first time starts on. Saving with the secret's field
  empty keeps the stored secret.
- **On and off** switches a saved service with no password, as pausing a job does. Switching a
  service off drops the notices that wait for its destinations.
- **Remove** deletes a service with its secret. Each user's destination on it stays saved, and
  reaches them again once the service is saved again.
- **?** beside a service's name shows and hides how to set it up: what to make at the service and
  what to enter on the card.
- For each service the page shows whether it is on, when it last took a notice, its latest failure,
  how many users have a destination on it, how many of those failed their last notice, and how many
  notices wait. To a user with the admin role it also shows the settings, and who saved it and when.

### My notifications

Every signed-in user sets where their own notices go and which ones they get.

- **My email address** and **My Telegram chat** are the two destinations. **Save** asks for your
  password: a changed address changes where the alerts go. A destination saved for the first time
  starts on. Saving another address in its place clears how the old one went.
- **On and off** and **Remove** take no password. Switching a destination off, or removing it,
  drops the notices that wait for it.
- **Send me a test notice** sends one notice to a saved destination, on or off, through the saved
  service, on or off. It says who asked for it and when. One goes out a minute at most to a
  destination. A test counts in no rule.
- **Find my chat** fills in the Telegram chat for you to save
  ([Finding a Telegram chat](#finding-a-telegram-chat)).
- **The topics** are a tick each, saved with no password. Your first saved destination ticks the
  four topics of stamp auto top-up for you. A user who saved no destination and no tick gets no
  notice. Beside each topic the page says how many people get it.
- For each destination the page shows whether it is on, when it last took a notice, why its last one
  failed, how many notices wait for it, and how its last test went.

What a user saves here is theirs. The API reads and writes it by the session's own user, and
answers it to that user alone. Of the other users, every answer holds numbers: how many people get a
topic, how many have a destination on a service, how many of those are failing. A user removed on
the Access page goes with their destinations, their topics and the notices that waited for them.

### Finding a Telegram chat

The bot can write to a chat once that chat wrote to the bot. Find my chat picks out your chat among
every chat that did:

1. **Find my chat** shows a code of ten letters and digits, and the bot's name with a link to it.
   The code holds for 10 minutes, and a new one replaces it.
2. Send the code from the chat your notices are to go to, in the way that chat takes:
   - **Your own chat with the bot:** open the link and press Start, which sends the code.
   - **A group the bot is in:** send the command the page shows, `/start@`, the bot's name and the
     code, as one message there. Telegram hands a bot in a group the commands addressed to it, and
     a plain message there stays with the group.
   - **A channel the bot is an administrator of:** post the code there.
3. Press **I sent it**. The admin reads the bot's latest messages with the saved token and looks
   for the one that holds your code. It fills that chat in, with its name, and you save it behind
   your password.

The answer is the one chat that sent your code. No route lists the chats that wrote to the bot. A
chat id can also be typed in by hand.

## Who gets a notice

A sender hands a notice over in parts, each under one topic and each about one thing: one coming
top-up, one warning, one stamp. It also hands over how the notice reads for any choice of its parts.

- A person **gets a topic** when they ticked it and have a destination that is on, on a service
  that is saved and on.
- Each person gets **one notice**, written from the parts whose topics they get, and it goes to each
  of their destinations that is on. A user who ticked "A top-up failed" alone reads of the failed
  top-up, in a notice with that title, while a user who ticked every topic reads of everything the
  tick raised.
- A part whose topic **nobody gets** goes to nobody. It shows on the page of whoever raised it: the
  Auto top-up tab for stamp auto top-up, which says so beside it.

## Notified

- A part of a notice is **notified** once one destination took a notice that held it. Stamp auto
  top-up counts its day of notice from that moment ([funding.md](funding.md#from-alert-to-top-up)).
- When **no destination** took a part, nothing is kept for it, each destination records why it
  failed, and the sender sends the part again on its next run: for stamp auto top-up the next tick,
  10 minutes later.
- A destination that **failed while another took** parts of its notice has those parts kept for it,
  as one notice, and is tried again at every tick. The notice carries the time it was raised. A
  destination that took a notice never gets it twice.
- A waiting notice is dropped a day after it was raised, when its destination or its service is
  switched off or removed, and when nothing it tells of stands any more: a warning that cleared, a
  top-up that was made.
- Nothing is tried twice within a tick. The destinations are called side by side and each call ends
  after 10 seconds, so a slow service holds up neither the other destinations nor the tick.

## The secrets and the addresses

- A service's secret is stored in the admin's database encrypted with AES-256-GCM, as the brand
  wallet's key is. The key is derived from `BRAND_WALLET_SECRET` with HKDF-SHA-256 under a label of
  its own, so it is another key than the one the brand wallet's key is under, and neither is in the
  database. Each stored secret records the version of its key.
- A stored secret opens only as the service it was saved for.
- With `BRAND_WALLET_SECRET` unset no service can be saved and no notice sent, and the page says so.
- No answer of the API holds a secret. The page shows that a service has one, never what it is.
- A secret is opened for the one send, the one test or the one Find my chat that needs it.
- Why a destination failed is kept with that destination, for its user to read. What every user
  reads of a service's latest failure is the service's status, or that no answer came: a sentence
  that holds none of the service's own words, and so no address.
- No log line and no audit entry holds a secret, an address that was called, a user's email address
  or a user's Telegram chat. Telegram's address carries the bot's token. A save of a destination is
  audited with its user and its service.

## The outgoing calls

- Every call goes over HTTPS to a host fixed in the code: `api.brevo.com` and `api.telegram.org`. A
  service's settings name no host.
- No redirect is followed.
- A call ends after 10 seconds, and at most 16 KB of the answer are read.
- Two calls read their answer, both for Find my chat, both with the bot's token. The Bot API's
  `getMe` gives the bot's name. Its `getUpdates` gives the bot's latest 20 updates, asked for with
  an offset of -20, on which Telegram forgets the updates before those. The admin sends no
  `allowed_updates`, which Telegram would keep for the bot. An answer longer than 16 KB is refused,
  not read in part.
- The admin host's outgoing traffic has to reach the hosts of the services in use, on port 443.

## The API

Under `/api/notifications`, behind the session, the writes behind the same-site check as well. The
routes under `/services` answer 403 to a user without the admin role. The routes under `/me` read
and write the session's own user.

| Route                                          | What it does                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/notifications`                       | The page's view: the services, my destinations and my topics    |
| `PUT /api/notifications/services/:kind`        | Saves a service, behind the password                            |
| `PUT …/services/:kind/enabled`                 | Switches a saved service on or off                              |
| `DELETE …/services/:kind`                      | Removes a service with its secret                               |
| `PUT /api/notifications/me/destinations/:kind` | Saves my destination on a service, behind the password          |
| `PUT …/me/destinations/:kind/enabled`          | Switches my destination on or off                               |
| `POST …/me/destinations/:kind/test`            | Sends me a test notice, and answers whether the service took it |
| `DELETE …/me/destinations/:kind`               | Removes my destination                                          |
| `PUT …/me/topics`                              | Saves the topics I get                                          |
| `POST …/me/telegram/code`                      | Starts my code, and answers it with the bot to send it to       |
| `POST …/me/telegram/chat`                      | Find my chat: the chat that sent my code                        |

`:kind` is `email` or `telegram`. The Auto top-up tab reads the same view for what it shows of the
notices.

## Setting a service up

[self-hosting.md](../self-hosting.md#notifications-from-the-admin) says what to create at each
service, what a user with the admin role enters on the page, and what each user does after that.
