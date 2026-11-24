import { autoTopUpEmailProblem, storedAutoTopUpEmail } from '@streaming-monorepo/web2-admin-common';

/**
 * The admin's mail settings, from the env file: the SMTP service the alerts and warnings of stamp auto top-up go
 * through (docs/architecture/funding.md, "Auto top-up"). An empty `SMTP_HOST` means no mail: the alerts and warnings
 * show on the Auto top-up tab alone. A value that does not parse stops the start with a sentence that names its key
 * and never repeats the password.
 */
export interface MailSettings {
  /** `SMTP_HOST`: the mail service's SMTP server, a host name or an IPv4 address. */
  host: string;
  /** `SMTP_PORT`: 587, where the connection is upgraded with STARTTLS, or 465, TLS from the start. */
  port: MailPort;
  /** `SMTP_USER`: the user name the mail service gave. */
  user: string;
  /** `SMTP_PASSWORD`: that user's password or key. A secret, never logged. */
  password: string;
  /** `SMTP_FROM`: the address the mails come from, trimmed and in lower case. */
  from: string;
}

export const SMTP_HOST_KEY = 'SMTP_HOST';
export const SMTP_PORT_KEY = 'SMTP_PORT';
export const SMTP_USER_KEY = 'SMTP_USER';
export const SMTP_PASSWORD_KEY = 'SMTP_PASSWORD';
export const SMTP_FROM_KEY = 'SMTP_FROM';

/** The two ports of an encrypted connection: 587 with STARTTLS, 465 with TLS from the start. */
export const MAIL_PORTS = [587, 465] as const;
export type MailPort = (typeof MAIL_PORTS)[number];

/** A DNS name of letters, digits, hyphens and dots, or an IPv4 address: nothing a URL or a command could hide in. */
const HOST_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Printable ASCII with no space: what an SMTP AUTH user name is. */
const USER_PATTERN = /^[\x21-\x7e]{1,254}$/;

function trimmed(env: Readonly<Record<string, string | undefined>>, key: string): string {
  return (env[key] ?? '').trim();
}

/**
 * The mail settings, or null while `SMTP_HOST` is empty. With a host set, the port, the user, the password and the
 * sender are required, since a hosted SMTP service takes mail only from a signed-in sender, and only over an
 * encrypted connection here.
 */
export function mailSettingsFrom(env: Readonly<Record<string, string | undefined>>): MailSettings | null {
  const host = trimmed(env, SMTP_HOST_KEY);
  if (host === '') return null;
  if (!HOST_PATTERN.test(host)) {
    throw new Error(
      `Env var ${SMTP_HOST_KEY} must be the SMTP server's host name, such as smtp.example.org, with no scheme or port, got: ${host}`,
    );
  }
  const portRaw = trimmed(env, SMTP_PORT_KEY);
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : Number.NaN;
  if (!(MAIL_PORTS as readonly number[]).includes(port)) {
    throw new Error(
      `Env var ${SMTP_PORT_KEY} must be 587, with STARTTLS, or 465, with TLS from the start, when ${SMTP_HOST_KEY} is set: the admin sends mail over an encrypted connection only. Got: ${portRaw || '(empty)'}`,
    );
  }
  const user = trimmed(env, SMTP_USER_KEY);
  if (!USER_PATTERN.test(user)) {
    throw new Error(
      `Env var ${SMTP_USER_KEY} is required when ${SMTP_HOST_KEY} is set: the user name the mail service gave, printable characters with no space`,
    );
  }
  const password = trimmed(env, SMTP_PASSWORD_KEY);
  if (password === '') {
    throw new Error(
      `Env var ${SMTP_PASSWORD_KEY} is required when ${SMTP_HOST_KEY} is set: the password or key of ${SMTP_USER_KEY} at the mail service`,
    );
  }
  if (/[\r\n]/.test(password)) {
    throw new Error(`Env var ${SMTP_PASSWORD_KEY} must be one line`);
  }
  const fromRaw = trimmed(env, SMTP_FROM_KEY);
  const fromProblem = fromRaw === '' ? 'It is empty.' : autoTopUpEmailProblem(fromRaw);
  if (fromProblem !== null) {
    throw new Error(
      `Env var ${SMTP_FROM_KEY} is required when ${SMTP_HOST_KEY} is set: the address the mails come from, one the mail service sends for, such as alerts@example.org. ${fromProblem}`,
    );
  }
  return { host, port: port as MailPort, user, password, from: storedAutoTopUpEmail(fromRaw) };
}

/** `smtp.example.org:587 (STARTTLS) as alerts@example.org`, or that mail is off: the boot log's line. No secret. */
export function describeMailSettings(settings: MailSettings | null): string {
  if (settings === null) {
    return `off (${SMTP_HOST_KEY} empty): the alerts and warnings show on the Funding page alone`;
  }
  const tls = settings.port === 465 ? 'TLS' : 'STARTTLS';
  return `${settings.host}:${settings.port} (${tls}) as ${settings.from}, signed in as ${settings.user}`;
}
