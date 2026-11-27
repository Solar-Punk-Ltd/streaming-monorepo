import { TELEGRAM_CHAT_CODE_SECONDS } from '@streaming-monorepo/web2-admin-common';

/**
 * Find my chat, asked with no code that holds: the user started none, or the last one is over. The API answers 409
 * `code_not_started` (`TELEGRAM_CODE_NOT_STARTED_ERROR`). Telegram was not asked.
 */
export class TelegramCodeNotStartedError extends Error {
  constructor() {
    super(
      `You have no code to find your chat with. Press Find my chat for one, and send it to the bot within ${
        TELEGRAM_CHAT_CODE_SECONDS / 60
      } minutes.`,
    );
    this.name = 'TelegramCodeNotStartedError';
  }
}
