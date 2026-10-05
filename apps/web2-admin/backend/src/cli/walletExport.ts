import { Database } from '../domain/Database.js';
import { exportBrandWalletKey } from '../domain/funding/BrandWallet.js';
import { BrandWalletRepository, type BrandWalletStore } from '../domain/funding/BrandWalletRepository.js';

/**
 * The brand wallet's backup: its private key, printed once, for the brand at handover (docs/architecture/funding.md).
 * With it the brand can move the wallet's funds from any wallet app, without this admin.
 *
 *   node dist/cli.js wallet:export --i-understand
 *
 * So can anyone else who holds it, which is why the command refuses without --i-understand. It needs
 * BRAND_WALLET_SECRET and the database, as the API does, and changes nothing in either. The key goes to standard
 * output alone, one line, and the warning and the address to standard error, so the key can be piped straight into a
 * password manager. Nothing is logged.
 */

export const WALLET_EXPORT = 'wallet:export';

const CONFIRM_FLAG = '--i-understand';

export const WALLET_EXPORT_USAGE = [
  'Usage:',
  `  node dist/cli.js ${WALLET_EXPORT} ${CONFIRM_FLAG}`,
  '',
  "Prints the brand wallet's private key once, for the backup handed to the",
  'brand at handover. Anyone who holds the key can move everything the wallet',
  `holds, so the command refuses without ${CONFIRM_FLAG}. It needs`,
  'BRAND_WALLET_SECRET and the database, as the API does. The key goes to',
  'standard output alone; the warning and the address go to standard error.',
].join('\n');

/** The warning printed before the key. */
const WARNING = [
  "WARNING: the brand wallet's private key is printed below, once.",
  '',
  "It is the brand's backup of the brand wallet, handed to the brand at handover.",
  'Anyone who holds it can move every xDAI and xBZZ the wallet holds, from any',
  "wallet app, without this admin. Put it straight into the brand's password",
  'manager. Never paste it into a chat, a ticket, an email or a log, and clear',
  "this terminal's scrollback once it is stored.",
  '',
];

/** Where the backup is written: the key alone to `out`, everything else to `err`. */
export interface BackupOutput {
  out(line: string): void;
  err(line: string): void;
}

const PROCESS_OUTPUT: BackupOutput = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/**
 * Prints the warning and the address, then the key once. Prints nothing when the wallet cannot be opened: no secret,
 * no wallet, or a secret that does not open it.
 */
export async function printBrandWalletBackup(
  store: BrandWalletStore,
  secret: string | null,
  output: BackupOutput = PROCESS_OUTPUT,
): Promise<void> {
  const { address, privateKey } = await exportBrandWalletKey(store, secret);
  for (const line of WARNING) output.err(line);
  output.err(`Address: ${address}`);
  output.out(privateKey);
}

export async function runWalletExport(argv: readonly string[]): Promise<void> {
  // The arguments are never repeated back: whatever was typed beside the flag stays off the screen and the log.
  if (argv.length !== 1 || argv[0] !== CONFIRM_FLAG) {
    throw new Error(
      `${WALLET_EXPORT} prints the brand wallet's private key, and takes ${CONFIRM_FLAG} and nothing else\n\n${WALLET_EXPORT_USAGE}`,
    );
  }

  // Loaded once the arguments are checked, so a refusal reads no env file and opens no database.
  const { config } = await import('../utils/config.js');
  const database = new Database(config.databaseUrl);
  try {
    await printBrandWalletBackup(new BrandWalletRepository(database.pool), config.brandWalletSecret);
  } finally {
    await database.close();
  }
}
