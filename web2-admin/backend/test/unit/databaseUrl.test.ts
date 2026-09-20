import assert from 'node:assert/strict';
import { test } from 'node:test';

import { databaseUrlFromEnvironment } from '../../src/utils/databaseUrl.js';

test('percent-encodes a release database password before constructing the URL', () => {
  const password = 'synthetic:@/#?% password';
  const databaseUrl = databaseUrlFromEnvironment({
    DATABASE_HOST: 'postgres',
    POSTGRES_PASSWORD: password,
  });
  const parsed = new URL(databaseUrl);

  assert.equal(parsed.protocol, 'postgres:');
  assert.equal(parsed.username, 'web2admin');
  assert.equal(decodeURIComponent(parsed.password), password);
  assert.equal(parsed.hostname, 'postgres');
  assert.equal(parsed.port, '5432');
  assert.equal(parsed.pathname, '/web2admin');
  assert.doesNotMatch(databaseUrl, /synthetic:@\/#\?% password/);
});

test('keeps an explicit database URL for existing deployments and tests', () => {
  const databaseUrl = 'postgres://test:already-encoded@127.0.0.1:5432/test';
  assert.equal(
    databaseUrlFromEnvironment({
      DATABASE_URL: databaseUrl,
      POSTGRES_PASSWORD: 'ignored-synthetic-password',
    }),
    databaseUrl,
  );
});
