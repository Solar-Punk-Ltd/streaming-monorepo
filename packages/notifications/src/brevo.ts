/**
 * Brevo, the email service the email channel sends through: one call to its transactional email API per mail, the API
 * key in a header. https://developers.brevo.com/reference/send-transac-email
 */

import { callService, type NotificationCallOptions } from './call.js';
import { NotificationSendError, type EmailProvider, type NotificationFetch, type OutgoingEmail } from './channel.js';
import { BREVO_API_HOST, channelSecretProblem, storedChannelSecret } from './rules.js';

/** The path of Brevo's call that sends one transactional mail. */
const BREVO_SEND_PATH = '/v3/smtp/email';

/** A mail's sender as Brevo takes it: a name only when there is one. */
function senderOf(email: OutgoingEmail): { email: string; name?: string } {
  return email.senderName.trim() === ''
    ? { email: email.senderAddress }
    : { email: email.senderAddress, name: email.senderName };
}

export class BrevoEmailProvider implements EmailProvider {
  readonly kind = 'brevo';
  // The language's private fields rather than TypeScript's, so no view of the object shows the key.
  readonly #apiKey: string;
  readonly #fetch: NotificationFetch | undefined;

  constructor(apiKey: string, options: NotificationCallOptions = {}) {
    this.#apiKey = storedChannelSecret(apiKey);
    this.#fetch = options.fetch;
  }

  /** Sends the mail to every recipient at once. Calls nothing with a key `channelSecretProblem` refuses. */
  async send(email: OutgoingEmail): Promise<void> {
    if (channelSecretProblem('email', this.#apiKey) !== null) {
      throw new NotificationSendError("The email service's API key is not one it gives out, so Brevo was not called.");
    }
    await callService(
      {
        service: 'Brevo',
        host: BREVO_API_HOST,
        path: BREVO_SEND_PATH,
        headers: { accept: 'application/json', 'api-key': this.#apiKey },
        body: {
          sender: senderOf(email),
          to: email.recipients.map((address) => ({ email: address })),
          subject: email.subject,
          textContent: email.text,
        },
        secrets: [this.#apiKey],
      },
      this.#fetch,
    );
  }
}
