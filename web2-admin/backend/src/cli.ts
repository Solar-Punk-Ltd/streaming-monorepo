import { Logger } from './domain/Logger.js';
import { getErrorMessage } from './utils/errorUtils.js';

/**
 * The backend's command line. One command so far, and it runs where the
 * database is reachable:
 *
 *   node dist/cli.js user:add <username>
 *
 * It is the only way to create a user on a fresh database: there is no sign-up
 * route, no SEED_ADMIN_PASSWORD and no seed file, deliberately. The command is
 * loaded when it is asked for, so printing the usage opens no database.
 */

const USER_ADD = 'user:add';

const USAGE = [
  'Usage:',
  '  node dist/cli.js <command> [options]',
  '',
  'Commands:',
  `  ${USER_ADD}  add a user, which is how the first one is made`,
  '',
  'Each command refuses with its own usage when its options are wrong.',
].join('\n');

const logger = Logger.getInstance();

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === USER_ADD) {
    return (await import('./cli/userAdd.js')).runUserAdd(rest);
  }

  throw new Error(command ? `unknown command: ${command}\n\n${USAGE}` : USAGE);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    logger.error(getErrorMessage(err));
    process.exit(1);
  });
