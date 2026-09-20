/**
 * Same singleton-Logger pattern as streaming-infra-manager and
 * swarm-hls-stream, so log output across the project is uniform.
 */
export class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] - ${args
      .map((arg) => this.formatArgument(arg))
      .join(' ')}`;
  }

  private formatArgument(arg: unknown): string {
    if (arg === null) return 'null';
    switch (typeof arg) {
      case 'string':
        return arg;
      case 'number':
      case 'bigint':
      case 'boolean':
      case 'symbol':
        return String(arg);
      case 'undefined':
        return 'undefined';
      case 'function':
        return arg.name ? `[Function ${arg.name}]` : '[Function]';
      case 'object':
        return JSON.stringify(arg) ?? 'undefined';
    }
  }

  log(...args: unknown[]): void {
    console.log(this.formatMessage('log', ...args));
  }

  info(...args: unknown[]): void {
    console.info(this.formatMessage('info', ...args));
  }

  warn(...args: unknown[]): void {
    console.warn(this.formatMessage('warn', ...args));
  }

  error(...args: unknown[]): void {
    console.error(this.formatMessage('error', ...args));
  }

  debug(...args: unknown[]): void {
    console.debug(this.formatMessage('debug', ...args));
  }
}
