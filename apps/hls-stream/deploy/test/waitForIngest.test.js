import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * `wait-for-ingest.sh`, the wait after SRS is recreated and before anything publishes to it. An engine can run while a port it should listen on is bound by nothing.
 *
 * SRS takes broadcasters on two listeners, SRT on a UDP port and RTMP on a TCP port, and the ladder's
 * rungs republish over the RTMP one, so the wait holds until both are there.
 */

/** Long enough for one probe, so a case that has to fail spends one round of the script's wait. */
const ONE_PROBE = '--timeout=1';

/**
 * A stub `ss` that answers a listening-socket query, `-l` with `-u` or `-t` and a `sport = :<port>`
 * filter, for the `<protocol>:<port>` pairs SS_STUB_BOUND names, and a query without `-l` for the
 * pairs SS_STUB_CONNECTED names. So a probe that asks the wrong protocol finds nothing, and one that
 * forgets `-l` finds only connections.
 */
function stubSs(sandbox) {
  const path = join(sandbox.binDir, 'ss');
  writeFileSync(
    path,
    `#!/bin/bash
flags=""
filter=""
for arg in "$@"; do
  case "$arg" in
    -H) ;;
    -*) flags+="\${arg#-}" ;;
    *) filter="$arg" ;;
  esac
done
case "$flags" in
  *u*) protocol=udp ;;
  *t*) protocol=tcp ;;
  *) exit 0 ;;
esac
case "$flags" in
  *l*) answers="\${SS_STUB_BOUND:-}" ;;
  *) answers="\${SS_STUB_CONNECTED:-}" ;;
esac
port="\${filter##*:}"
for pair in $answers; do
  if [ "$pair" = "$protocol:$port" ]; then
    echo "LISTEN 0 128 0.0.0.0:$port 0.0.0.0:*"
  fi
done
`,
  );
  chmodSync(path, 0o755);
}

function sandboxWithSs(options) {
  const sandbox = makeSandbox(options);
  stubSs(sandbox);
  return sandbox;
}

describe('wait-for-ingest.sh waits for both of SRS’s ingest listeners', () => {
  it('returns once SRS listens for SRT and for RTMP, and names both ports', async () => {
    const sandbox = sandboxWithSs();

    const run = await runScriptOk(sandbox, 'wait-for-ingest.sh', [ONE_PROBE], {
      SS_STUB_BOUND: 'udp:10080 tcp:1935',
    });

    assert.match(run.stdout, /SRS ingest bound: SRT on UDP 10080, RTMP on TCP 1935/);
  });

  it('fails while nothing listens on the RTMP port, though the SRT one is bound, and says which', async () => {
    const sandbox = sandboxWithSs();

    const run = await runScript(sandbox, 'wait-for-ingest.sh', [ONE_PROBE], { SS_STUB_BOUND: 'udp:10080' });
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a dead RTMP listener passed the wait: ${said}`);
    assert.match(said, /no listener on TCP 1935 \(RTMP\)/);
    assert.doesNotMatch(said, /no listener on UDP/, 'the SRT listener was there and is blamed anyway');
  });

  it('fails while nothing listens on the SRT port, though the RTMP one is bound, and says which', async () => {
    const sandbox = sandboxWithSs();

    const run = await runScript(sandbox, 'wait-for-ingest.sh', [ONE_PROBE], { SS_STUB_BOUND: 'tcp:1935' });
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a dead SRT listener passed the wait: ${said}`);
    assert.match(said, /no listener on UDP 10080 \(SRT\)/);
    assert.doesNotMatch(said, /no listener on TCP/, 'the RTMP listener was there and is blamed anyway');
  });

  it('does not count a connection to the RTMP port as its listener', async () => {
    const sandbox = sandboxWithSs();

    const run = await runScript(sandbox, 'wait-for-ingest.sh', [ONE_PROBE], {
      SS_STUB_BOUND: 'udp:10080',
      SS_STUB_CONNECTED: 'tcp:1935',
    });

    assert.notEqual(run.exitCode, 0, `an RTMP connection stood in for the listener: ${run.stdout}${run.stderr}`);
  });

  it('waits on the ports the deploy gave SRS under a port slot', async () => {
    const sandbox = sandboxWithSs();

    const run = await runScriptOk(sandbox, 'wait-for-ingest.sh', ['--portSlot=2', ONE_PROBE], {
      SS_STUB_BOUND: 'udp:10021 tcp:10022',
    });

    assert.match(run.stdout, /SRS ingest bound: SRT on UDP 10021, RTMP on TCP 10022/);
  });

  it('asks a remote target for both listeners over ssh', async () => {
    const sandbox = sandboxWithSs({ config: ALL_REMOTE });

    await runScriptOk(sandbox, 'wait-for-ingest.sh', [ONE_PROBE], { SS_STUB_BOUND: 'udp:10080 tcp:1935' });

    const asked = sandbox.sshCommands();
    assert.ok(asked.includes('ss -H -lun "sport = :10080"'), `no SRT probe among ${JSON.stringify(asked)}`);
    assert.ok(asked.includes('ss -H -ltn "sport = :1935"'), `no RTMP probe among ${JSON.stringify(asked)}`);
  });
});
