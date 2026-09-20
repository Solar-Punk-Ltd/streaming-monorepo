function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * Release Compose passes the original password to Postgres and the API. The API constructs the
 * connection URL here so URL delimiters in a generated password are encoded before pg parses it.
 * Existing deployments that provide DATABASE_URL without the release component fields keep their
 * current connection string.
 */
export function databaseUrlFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  const host = environment.DATABASE_HOST?.trim();
  if (!host) return required(environment, 'DATABASE_URL');

  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('Env var DATABASE_HOST is invalid');
  }
  const port = environment.DATABASE_PORT?.trim() || '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error('Env var DATABASE_PORT is invalid');
  }
  const username = environment.DATABASE_USER?.trim() || 'web2admin';
  const database = environment.DATABASE_NAME?.trim() || 'web2admin';
  const password = required(environment, 'POSTGRES_PASSWORD');
  return `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}
