// Stands in for the docker CLI in tests. It records each call, then answers with the first reply in the
// scenario whose `argsInclude` are all among the arguments and whose `cwd`, when given, is the directory it
// runs in. `{{cwd}}` in a reply's stdout becomes that directory, which is how real compose writes paths.
// A reply's `sleepMs` holds the call that long first, which is how a test stands in for a slow build.
import { appendFileSync, createReadStream, readFileSync, realpathSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.FAKE_DOCKER_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
const recordedEnv = Object.fromEntries((scenario.recordEnv ?? []).map((name) => [name, process.env[name]]));

appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ args, cwd, env: recordedEnv })}\n`);

const reply = scenario.replies.find(
  (candidate) => candidate.argsInclude.every((arg) => args.includes(arg)) && (candidate.cwd === undefined || candidate.cwd === cwd),
);

if (reply?.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, reply.sleepMs);

if (!reply) {
  process.stderr.write(`fake docker has no reply for: ${args.join(' ')}\n`);
  process.exitCode = 99;
} else if (reply.stdoutFile) {
  createReadStream(reply.stdoutFile).pipe(process.stdout);
  process.stderr.write(reply.stderr ?? '');
  process.exitCode = reply.status ?? 0;
} else {
  process.stdout.write((reply.stdout ?? '').replaceAll('{{cwd}}', cwd));
  process.stderr.write(reply.stderr ?? '');
  process.exitCode = reply.status ?? 0;
}
