import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_ENV, makeTempDir } from './fixtures.mjs';

const FAKE_DOCKER_CLI = fileURLToPath(new URL('./fake-docker-cli.mjs', import.meta.url));

/**
 * Puts a `docker` that answers from `scenario` first on PATH, for one test.
 * Returns the environment to run a script with and a reader for the calls it received.
 * @param {{ replies: Array<{ argsInclude: string[], cwd?: string, stdout?: string, stdoutFile?: string, stderr?: string, status?: number }>, recordEnv?: string[] }} scenario
 */
export function installFakeDocker(t, scenario) {
  const dir = makeTempDir(t, 'move-check-docker-');
  const scenarioPath = join(dir, 'scenario.json');
  const callLogPath = join(dir, 'calls.jsonl');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(callLogPath, '');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER_CLI}" "$@"\n`, { mode: 0o755 });
  return {
    env: {
      ...TEST_ENV,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_SCENARIO: scenarioPath,
      FAKE_DOCKER_LOG: callLogPath,
    },
    calls: () =>
      readFileSync(callLogPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line)),
  };
}
