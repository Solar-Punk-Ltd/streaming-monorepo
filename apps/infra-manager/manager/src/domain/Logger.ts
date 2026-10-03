/** The levels LOG_LEVEL names, from the one that writes the most to the one that writes the least. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** What the logger writes at until the api applies LOG_LEVEL, and what an unset LOG_LEVEL means. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Whether a value names a level. A lookup in the list rather than `in` on an
 * object, which `constructor` and `__proto__` pass.
 */
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Same singleton-Logger pattern used in swarm-hls-stream/stream-uploader so
 * log output across the project is uniform.
 */
export class Logger {
  private static instance: Logger;
  private everythingToStandardError = false;
  private level: LogLevel = DEFAULT_LOG_LEVEL;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Drops every line below `level` from here on, and answers the level it
   * replaces so a test can put it back. The api calls it with LOG_LEVEL once
   * at startup; anything else logs at {@link DEFAULT_LOG_LEVEL}.
   *
   * There is no trace method, so `trace` writes what `debug` does. `log`
   * counts as `info`.
   */
  public setLevel(level: LogLevel): LogLevel {
    const previous = this.level;
    this.level = level;
    return previous;
  }

  /**
   * Sends every level to standard error from here on.
   *
   * A command of the manager's command line writes one machine-read line on
   * standard output and nothing else, because the deploy that runs it reads
   * exactly that line. Anything logged while the command works, a migration
   * saying which file it applied for instance, would otherwise land in the
   * middle of it.
   */
  public writeEverythingToStandardError(): void {
    this.everythingToStandardError = true;
  }

  private formatMessage(level: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] - ${args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ')}`;
  }

  /** `label` is what the line says, `level` what it is filtered as. They differ only for `log`. */
  private write(label: string, level: LogLevel, at: (message: string) => void, args: unknown[]): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return;
    const message = this.formatMessage(label, ...args);
    if (this.everythingToStandardError) console.error(message);
    else at(message);
  }

  log(...args: unknown[]): void {
    this.write('log', 'info', (message) => console.log(message), args);
  }

  info(...args: unknown[]): void {
    this.write('info', 'info', (message) => console.info(message), args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', 'warn', (message) => console.warn(message), args);
  }

  error(...args: unknown[]): void {
    this.write('error', 'error', (message) => console.error(message), args);
  }

  debug(...args: unknown[]): void {
    this.write('debug', 'debug', (message) => console.debug(message), args);
  }
}
