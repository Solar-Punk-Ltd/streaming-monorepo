import nodemailer from 'nodemailer';

import type { MailSettings } from '../../utils/mailSettings.js';

/** A mail as the admin sends it: a subject and a plain text body, nothing attached and nothing fetched. */
export interface OutgoingMail {
  subject: string;
  text: string;
}

/**
 * Sends the admin's mails, those of stamp auto top-up (docs/architecture/funding.md, "Mails and warnings"). `send`
 * resolves once the mail service took the mail, and rejects with a {@link MailSendError} whose message is a sentence
 * for the Auto top-up tab, with no secret in it.
 */
export interface Mailer {
  /** Whether SMTP is set. False, nothing is sent and the alerts and warnings show on the page alone. */
  readonly configured: boolean;
  send(to: readonly string[], mail: OutgoingMail): Promise<void>;
}

/** Why a mail could not be sent, in a sentence the Auto top-up tab shows. */
export class MailSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailSendError';
  }
}

/** The mailer while `SMTP_HOST` is empty: never sends, and says so if asked to. */
export const NO_MAILER: Mailer = {
  configured: false,
  send: () => Promise.reject(new MailSendError('Mail is not set up: SMTP_HOST is empty.')),
};

/** How long a connection may take to open, and the server to greet: a mail service that hangs never holds a tick. */
export const MAIL_CONNECTION_TIMEOUT_MS = 30_000;
/** How long a connection may sit idle in the middle of a send. */
export const MAIL_SOCKET_TIMEOUT_MS = 60_000;

/** The longest part of the mail service's own answer a failure's sentence repeats. */
const SERVER_ANSWER_MAX_LENGTH = 200;

/** What {@link SmtpMailer} hands nodemailer, so a test can read the connection it would open. */
export type SmtpTransportOptions = Parameters<typeof nodemailer.createTransport>[0] & object;

/** What a transport offers the mailer: nodemailer's `sendMail`, reduced to what is used. */
export interface SmtpTransport {
  sendMail(message: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
}

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

const nodemailerTransport: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

/**
 * The connection the admin opens to the mail service: TLS from the start on 465, and on 587 a STARTTLS upgrade the
 * server must offer, or the send fails before anything is said. Never a plain connection, the certificate checked
 * against the host name, TLS 1.2 at the least. The transport reads no file and fetches no address, whatever a message
 * holds.
 */
export function smtpTransportOptions(settings: MailSettings): SmtpTransportOptions {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    requireTLS: settings.port === 587,
    ignoreTLS: false,
    opportunisticTLS: false,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: settings.host },
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    socketTimeout: MAIL_SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** One line of at most {@link SERVER_ANSWER_MAX_LENGTH} printable characters, with every copy of `secret` hidden. */
function cleanAnswer(text: string, secret: string): string {
  const hidden = secret === '' ? text : text.split(secret).join('[hidden]');
  const line = hidden.replace(/[^\x20-\x7e]+/g, ' ').trim();
  return line.length > SERVER_ANSWER_MAX_LENGTH ? `${line.slice(0, SERVER_ANSWER_MAX_LENGTH)}…` : line;
}

/** nodemailer's error codes, as a sentence each. */
const CODE_SENTENCES: Readonly<Record<string, string>> = {
  EAUTH: 'The mail service refused the sign-in: check SMTP_USER and SMTP_PASSWORD.',
  ECONNECTION: 'The mail service could not be reached: check SMTP_HOST and SMTP_PORT, and that the host may reach it.',
  EDNS: 'The mail service could not be found: check SMTP_HOST.',
  ETIMEDOUT: 'The mail service did not answer in time.',
  ESOCKET: 'The connection to the mail service broke.',
  ETLS: 'The encrypted connection to the mail service could not be made.',
  EENVELOPE: 'The mail service refused the sender or the recipients: check SMTP_FROM and the email list.',
  EMESSAGE: 'The mail service refused the mail.',
  EPROTOCOL: 'The mail service answered in a way the admin does not understand.',
};

/** The sentence a failed send is recorded with: what failed, and the mail service's own answer when there is one. */
export function mailFailureSentence(error: unknown, secret: string): string {
  const details = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    response?: unknown;
    message?: unknown;
  };
  const code = typeof details.code === 'string' ? details.code : null;
  const sentence = (code !== null ? CODE_SENTENCES[code] : undefined) ?? 'The mail could not be sent.';
  const answerSource =
    typeof details.response === 'string'
      ? details.response
      : typeof details.message === 'string'
        ? details.message
        : '';
  const answer = cleanAnswer(answerSource, secret);
  return answer === '' ? sentence : `${sentence} The mail service said: ${answer}`;
}

/** The mailer over SMTP, one connection per mail: a handful of mails a week keeps nothing open between them. */
export class SmtpMailer implements Mailer {
  readonly configured = true;
  private readonly transport: SmtpTransport;

  constructor(
    private readonly settings: MailSettings,
    factory: SmtpTransportFactory = nodemailerTransport,
  ) {
    this.transport = factory(smtpTransportOptions(settings));
  }

  async send(to: readonly string[], mail: OutgoingMail): Promise<void> {
    if (to.length === 0) throw new MailSendError('The email list is empty.');
    try {
      await this.transport.sendMail({ from: this.settings.from, to: [...to], subject: mail.subject, text: mail.text });
    } catch (error) {
      throw new MailSendError(mailFailureSentence(error, this.settings.password), { cause: error });
    }
  }
}

/** The mailer of these settings: SMTP, or none while `SMTP_HOST` is empty. */
export function mailerFrom(settings: MailSettings | null): Mailer {
  return settings === null ? NO_MAILER : new SmtpMailer(settings);
}
