/**
 * A backend of the suite's own: its own database, its own port, its own first
 * user, and `FEED_GATEWAY=fake` so nothing it publishes reaches Swarm.
 *
 * It exists because there is nothing left to borrow. There is no seeded admin
 * any more — a fresh database has no users and refuses every sign-in until the
 * `user:add` CLI has run — so a suite that pointed at whatever was listening on
 * :9877 would have no credentials, and pointing it at the development backend
 * would publish and unpublish through a real Bee node and a real catalogue.
 *
 * Both halves of the boot are the real ones: the process is `src/index.ts`
 * under tsx, so it runs the migrations and starts the session sweep, and the
 * first user is made by running `src/cli.ts user:add` against the same
 * database, which is the only way a user can be made at all.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web2-admin/backend, whatever the suite was run from. */
const PACKAGE_ROOT = join(here, '..', '..');
const TSX = join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');

/** Where to reach Postgres. The throwaway database is created beside it. */
const ADMIN_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://web2admin:web2admin@127.0.0.1:5433/web2admin';

export const ITEST_USERNAME = 'itest-admin';
export const ITEST_PASSWORD = 'integration-suite-password';
export const ITEST_INTERNAL_TOKEN = 'web2-admin-integration-internal-token-000000';

/** Hardhat's first test account: public, and it signs nothing that matters. */
const FEED_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const BOOT_TIMEOUT_MS = 60_000;

export interface Instance {
  url: string;
  databaseUrl: string;
  /** Adds another user through the CLI, the way an operator would. */
  addUser(username: string, password: string, admin?: boolean): Promise<void>;
  stop(): Promise<void>;
}

function databaseNameFor(url: string): { admin: string; name: string; target: string } {
  const name = `web2admin_itest_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const target = new URL(url);
  target.pathname = `/${name}`;
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return { admin: admin.toString(), name, target: target.toString() };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not find a free port');
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

function childEnvironment(databaseUrl: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    WEB2_ADMIN_PORT: String(port),
    WEB2_ADMIN_HOST: '127.0.0.1',
    // Nothing this suite does may reach Swarm or a real catalogue.
    FEED_GATEWAY: 'fake',
    FEED_PRIVATE_KEY,
    FEED_TOPIC: 'web2-admin-integration',
    BEE_URL: 'http://127.0.0.1:1633',
    POSTAGE_BATCH_ID: '0000000000000000000000000000000000000000000000000000000000000000',
    VIEWER_BASE_URL: '',
    INTERNAL_API_TOKEN: ITEST_INTERNAL_TOKEN,
    INGEST_HOST: 'ingest.itest.invalid',
    INGEST_SRT_PASSPHRASE: '',
  };
}

async function runToCompletion(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<void> {
  const child = spawn(command, [...args], {
    cwd: PACKAGE_ROOT,
    env: environment,
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (stdin !== undefined) child.stdin!.end(stdin);

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${code}:\n${output}`);
  }
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = 'no attempt made';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the backend exited with ${child.exitCode} before it was ready`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      lastError = `health answered ${res.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the backend never became healthy: ${lastError}`);
}

export async function startInstance(): Promise<Instance> {
  const { admin, name, target } = databaseNameFor(ADMIN_DATABASE_URL);

  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  try {
    await adminPool.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await adminPool.end();
    throw new Error(
      `could not create the throwaway database at ${admin} (${String(err)}).\n` +
        'Start Postgres with: pnpm database:start',
      { cause: err },
    );
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const environment = childEnvironment(target, port);

  const addUser = async (username: string, password: string, isAdmin = true): Promise<void> => {
    await runToCompletion(
      TSX,
      [
        '--conditions=development',
        'src/cli.ts',
        'user:add',
        username,
        '--password-stdin',
        ...(isAdmin ? ['--admin'] : []),
      ],
      environment,
      `${password}\n`,
    );
  };

  // Before the server, because the CLI runs the migrations itself and the
  // first user has to exist for anything at all to be reachable.
  await addUser(ITEST_USERNAME, ITEST_PASSWORD);

  const child = spawn(TSX, ['--conditions=development', 'src/index.ts'], {
    cwd: PACKAGE_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('close', () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await adminPool.end();
    }
  };

  try {
    await waitForHealth(url, child);
  } catch (err) {
    await stop();
    throw new Error(`${String(err)}\n${log}`, { cause: err });
  }

  return { url, databaseUrl: target, addUser, stop };
}
