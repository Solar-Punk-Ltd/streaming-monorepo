import { Logger } from './domain/Logger.js';
import { getErrorMessage } from './utils/errorUtils.js';

/**
 * The backend's command line. Two commands, each run where the database is
 * reachable:
 *
 *   node dist/cli.js user:add <username>
 *   node dist/cli.js wallet:export --i-understand
 *
 * `user:add` is the only way to create a user on a fresh database: there is no
 * sign-up route, no SEED_ADMIN_PASSWORD and no seed file, deliberately.
 * `wallet:export` prints the brand wallet's private key once, for the backup
 * handed to the brand. A command is loaded when it is asked for, so printing
 * the usage opens no database.
 */

const USER_ADD = 'user:add';
const WALLET_EXPORT = 'wallet:export';

const USAGE = [
  'Usage:',
  '  node dist/cli.js <command> [options]',
  '',
  'Commands:',
  `  ${USER_ADD}       add a user, which is how the first one is made`,
  `  ${WALLET_EXPORT}  print the brand wallet's private key once, for the brand's backup`,
  '',
  'Each command refuses with its own usage when its options are wrong.',
].join('\n');

const logger = Logger.getInstance();

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === USER_ADD) {
    return (await import('./cli/userAdd.js')).runUserAdd(rest);
  }
  if (command === WALLET_EXPORT) {
    return (await import('./cli/walletExport.js')).runWalletExport(rest);
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
