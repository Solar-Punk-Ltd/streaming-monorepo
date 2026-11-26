/**
 * The one call every channel makes to its service: a `POST` of a JSON body over https to a host `rules.ts` fixes. It
 * follows no redirect, ends after `NOTIFICATION_CALL_TIMEOUT_MS`, and reads at most `NOTIFICATION_ANSWER_MAX_BYTES` of
 * the answer. It resolves once the service answers with a 2xx status, and otherwise rejects with a
 * {@link NotificationSendError} whose sentence holds the status and a short part of the service's own words, with the
 * secret and the address that was called cut out of them.
 *
 * `readService` makes the same call and answers the text of a 2xx answer, for the two reads the package makes, both for
 * Find my chat: Telegram's `getMe` and `getUpdates`.
 */

import { NotificationSendError, type NotificationFetch } from './channel.js';
import {
  BREVO_API_HOST,
  NOTIFICATION_ANSWER_MAX_BYTES,
  NOTIFICATION_CALL_TIMEOUT_MS,
  NOTIFICATION_SERVICE_WORDS_MAX_LENGTH,
  TELEGRAM_API_HOST,
} from './rules.js';

/** What a channel or an email provider makes its calls with. */
export interface NotificationCallOptions {
  /** The `fetch` every call goes through, the global one when left out. A test hands in its own. */
  fetch?: NotificationFetch;
}

/** The hosts a call can go to: the ones `rules.ts` fixes, and no other. */
export type ServiceHost = typeof BREVO_API_HOST | typeof TELEGRAM_API_HOST;

const SERVICE_HOSTS: readonly string[] = [BREVO_API_HOST, TELEGRAM_API_HOST];

/** One call to a service. */
export interface ServiceCall {
  /** The service, as a failure's sentence names it: `Brevo` or `Telegram`. */
  service: string;
  host: ServiceHost;
  /** The path on the host, from its first slash. */
  path: string;
  /** The headers beside `content-type`, which is JSON's. */
  headers?: Readonly<Record<string, string>>;
  /** What is sent, written as JSON. */
  body: unknown;
  /**
   * What a failure's sentence never repeats: the secret, and each part of it a service could repeat on its own. The
   * address that was called is never repeated either, without being named here.
   */
  secrets: readonly string[];
}

/** What a secret, or the address that was called, reads as in the service's words. */
const HIDDEN = '[hidden]';

/** The shortest part of a secret that is cut out of the service's words. A shorter one is too common to cut. */
const SECRET_PART_MIN_LENGTH = 4;

/**
 * The fields a service's JSON error explains itself in, the first one found used: Telegram's `description`, Brevo's
 * `message`, and `error`.
 */
const EXPLANATION_FIELDS = ['description', 'message', 'error'] as const;

/** A code the runtime names a network failure by, such as `ENOTFOUND` or `ECONNREFUSED`: a name, never an address. */
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/** The sentence ended with a full stop, unless it ends in a mark of its own. */
function sentence(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

/** Every run of characters that are not printable, line breaks and other spaces among them, as one space. */
function printable(text: string): string {
  return text.replace(/[\p{C}\p{Z}]+/gu, ' ').trim();
}

/**
 * What a service's answer says about itself: the explanation of a JSON error, or the answer's text. A JSON answer with
 * no explanation is written again, so a value the service escaped, such as a slash written `\/`, reads as itself and a
 * secret in it is cut out.
 */
function explanationOf(answer: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return answer;
  }
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    for (const field of EXPLANATION_FIELDS) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return JSON.stringify(parsed);
}

/**
 * The service's own words in its answer, as a failure's sentence repeats them: the answer's explanation, every run of
 * characters that are not printable as one space, each of `hidden` cut out, the longest first, and at most
 * `NOTIFICATION_SERVICE_WORDS_MAX_LENGTH` characters, the last of a longer one an ellipsis.
 */
export function serviceWords(answer: string, hidden: readonly string[]): string {
  const cuts = hidden.filter((value) => value.length >= SECRET_PART_MIN_LENGTH).sort((a, b) => b.length - a.length);
  const words = cuts.reduce((text, value) => text.split(value).join(HIDDEN), printable(explanationOf(answer)));
  const characters = Array.from(words);
  if (characters.length <= NOTIFICATION_SERVICE_WORDS_MAX_LENGTH) return words;
  return `${characters
    .slice(0, NOTIFICATION_SERVICE_WORDS_MAX_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/** The code a network failure is named by, off the error or one of its causes, or null. */
function failureCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && FAILURE_CODE_PATTERN.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Why no answer came: the code of the network failure when it has one. The error itself is not kept as the cause,
 * since the runtime's own words can hold the address that was called.
 */
function unreachable(service: string, error: unknown): NotificationSendError {
  const code = failureCode(error);
  return new NotificationSendError(`${service} could not be reached${code === null ? '' : ` (${code})`}.`);
}

function timedOut(service: string): NotificationSendError {
  return new NotificationSendError(`${service} did not answer within ${NOTIFICATION_CALL_TIMEOUT_MS / 1000} seconds.`);
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * The address of the call: a path on one of the fixed hosts, over https on its own port. Throws, without naming the
 * path, for any other.
 */
function addressOf(call: ServiceCall): string {
  const origin = `https://${call.host}`;
  let url: URL | null = null;
  if (SERVICE_HOSTS.includes(call.host) && call.path.startsWith('/')) {
    try {
      url = new URL(call.path, origin);
    } catch {
      url = null;
    }
  }
  if (url === null || url.origin !== origin) {
    throw new NotificationSendError(`${call.service} was not called: its address is not on the service's own host.`);
  }
  return url.href;
}

/** Drops an answer unread. A body that cannot be cancelled goes with the call's end. */
function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** What was read of an answer. */
interface AnswerRead {
  text: string;
  /** Whether that is the whole answer: it ended within `NOTIFICATION_ANSWER_MAX_BYTES`, unbroken and in time. */
  whole: boolean;
}

/**
 * The answer's text: `NOTIFICATION_ANSWER_MAX_BYTES` of it at most, read until it ends, until that much came, or until
 * the call's end, whichever is first. What came before an answer broke off is kept, since a failure is read for its
 * words alone. The signal stops a body that stops arriving, whether or not the fetch ties it to the body.
 */
async function readAnswer(response: Response, signal: AbortSignal): Promise<AnswerRead> {
  if (response.body === null) return { text: '', whole: true };
  const reader = response.body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let whole = false;
  try {
    while (bytes < NOTIFICATION_ANSWER_MAX_BYTES && !signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        whole = true;
        break;
      }
      const part = chunk.value.subarray(0, NOTIFICATION_ANSWER_MAX_BYTES - bytes);
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
    }
  } catch {
    // The answer broke off: its words are what came before.
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
  return { text: text + decoder.decode(), whole };
}

/**
 * Makes the call. Resolves once the service answered with a 2xx status, whose answer is not read: the status says the
 * service took what was sent. Rejects with a {@link NotificationSendError} for a call that was not made, an answer that
 * did not come in time, a redirect, and any other status.
 */
export async function callService(call: ServiceCall, fetchFn: NotificationFetch = fetch): Promise<void> {
  await exchange(call, fetchFn, false);
}

/**
 * Makes the call as {@link callService} does, and answers the text of the service's 2xx answer. Rejects as it does,
 * and as well for an answer that did not come whole: longer than `NOTIFICATION_ANSWER_MAX_BYTES`, broken off, or not
 * in time.
 */
export async function readService(call: ServiceCall, fetchFn: NotificationFetch = fetch): Promise<string> {
  return exchange(call, fetchFn, true);
}

/** The call of {@link callService} and {@link readService}: a 2xx answer is read when `read` is true, else dropped. */
async function exchange(call: ServiceCall, fetchFn: NotificationFetch, read: boolean): Promise<string> {
  const address = addressOf(call);
  // Aborted at the deadline, and once the call is over, so an answer left unread does not hold the connection.
  const finished = new AbortController();
  let late = false;
  // A timer of this module's own rather than AbortSignal.timeout, so a test's mocked clock can run it.
  const deadline = setTimeout(() => {
    late = true;
    finished.abort();
  }, NOTIFICATION_CALL_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchFn(address, {
        method: 'POST',
        headers: { ...call.headers, 'content-type': 'application/json' },
        body: JSON.stringify(call.body),
        redirect: 'manual',
        signal: finished.signal,
      });
    } catch (error) {
      throw late ? timedOut(call.service) : unreachable(call.service, error);
    }
    if (isRedirect(response)) {
      discard(response);
      const status = response.status === 0 ? null : response.status;
      const which = status === null ? '' : `, status ${status}`;
      throw new NotificationSendError(`${call.service} answered with a redirect${which}, which is not followed.`, {
        status,
      });
    }
    if (response.ok) {
      if (!read) {
        discard(response);
        return '';
      }
      const answer = await readAnswer(response, finished.signal);
      if (late) throw timedOut(call.service);
      if (!answer.whole) {
        throw new NotificationSendError(
          `${call.service}'s answer could not be read whole: it broke off, or it is longer than ${
            NOTIFICATION_ANSWER_MAX_BYTES / 1024
          } KB.`,
          { status: response.status },
        );
      }
      return answer.text;
    }
    const words = serviceWords((await readAnswer(response, finished.signal)).text, [address, ...call.secrets]);
    const said = words === '' ? '' : `: ${words}`;
    throw new NotificationSendError(sentence(`${call.service} answered with status ${response.status}${said}`), {
      status: response.status,
    });
  } finally {
    clearTimeout(deadline);
    finished.abort();
  }
}
