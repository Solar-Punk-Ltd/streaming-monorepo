import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * What the compose files hand to a browser and to the network, read off the file text.
 *
 * ⛔ The file text is the lever here because there is nothing else to ask. A Bee CORS flag and a
 * published port's host-side address are both arguments to a container this repository never starts
 * in a test: no module reads them, no script derives them, and the only other place either one shows
 * up is a running deployment, where reading it costs a host with a public address and a second
 * machine to dial it from. So this file parses compose the way an operator reads it.
 *
 * It is written to go stale loudly rather than quietly. The service list is computed from the file
 * rather than listed here, so a node added tomorrow is checked without anybody remembering to come
 * back.
 */

/** The Bee flag that lets a page on any other origin read a node's answers. */
const CORS_FLAG = '--cors-allowed-origins';

/**
 * The one Bee node a browser is meant to talk to.
 *
 * The viewer fetches segments from it, so without the flag every retrieval fails at the preflight.
 * The other four hold the postage batches and the wallets this project spends, and nothing in a
 * browser has any business reaching them: the deployed viewer is forced onto the same-origin nginx
 * proxy by `deploy.sh`, and in local development vite proxies the same path.
 */
const BROWSER_FACING = 'bee-gateway';

/** Every compose file that starts a Bee node. */
const BEE_COMPOSE_FILES = ['deploy/docker-compose.yml', 'nodes/docker-compose.yml'];

/** Every compose file in the repository that publishes a port. */
const PORT_COMPOSE_FILES = [
  'deploy/docker-compose.yml',
  'nodes/docker-compose.yml',
  'engines/srs/docker-compose.yml',
  'engines/ome/docker-compose.yml',
  'engines/ome/docker-compose.local.yml',
];

/**
 * The binds that default to every address, and why: these are the ports the outside world dials. Each
 * is still a setting, because which addresses a host answers on is the operator's to decide, and which
 * of them the internet reaches is the operator's firewall.
 *
 * Keyed by the bind variable, which is what survives a rename and a reindent. Every published port has
 * to carry a bind, and every bind is either here or an admin bind below, so a port added without one,
 * or with a default nobody chose, fails here rather than being found from outside.
 */
const OPEN_BY_DEFAULT = new Map([
  ['BEE_UPLOADER_P2P_BIND', 'P2P is how the node reaches Swarm, and restricting it cuts the node off'],
  ['BEE_RUNG_480P_P2P_BIND', 'P2P, as above'],
  ['BEE_RUNG_720P_P2P_BIND', 'P2P, as above'],
  ['BEE_RUNG_1080P_P2P_BIND', 'P2P, as above'],
  ['BEE_GATEWAY_P2P_BIND', 'P2P, as above'],
  ['SRS_RTMP_BIND', 'ingest: a broadcaster dials it from wherever they are'],
  ['SRS_SRT_BIND', 'ingest, as above'],
  ['OME_SRT_BIND', 'ingest, as above'],
  ['CLIENT_BIND', 'the viewer opens this one in a browser'],
  [
    'API_BIND',
    "the uploader's own API, and the one port here with authentication of its own: every gated route " +
      'needs the bearer token, there is no unauthenticated mode, and the engines post their webhooks to it',
  ],
]);

/**
 * The binds of every admin and file interface: the Bee APIs, SRS's control API and file server, and
 * OME's HLS port.
 */
const ADMIN_BINDS = new Set([
  'BEE_UPLOADER_API_BIND',
  'BEE_RUNG_480P_API_BIND',
  'BEE_RUNG_720P_API_BIND',
  'BEE_RUNG_1080P_API_BIND',
  'BEE_GATEWAY_API_BIND',
  'SRS_HTTP_BIND',
  'SRS_HTTP_API_BIND',
  'OME_HTTP_BIND',
]);

function composeText(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/** Every service a compose file declares, in file order. */
function servicesOf(text) {
  return text
    .split('\n')
    .map((line) => /^ {2}([a-z0-9-]+):$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

/** One service block, from its own name down to the next key at the same indent. */
function blockOf(text, service) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert.notEqual(start, -1, `service ${service} is not in the compose file`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[^ ]/.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
}

/** The entries of one service's `ports:` list, comments skipped, stopping at the next key. */
function portEntriesOf(block) {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line === '    ports:');
  if (start === -1) {
    return [];
  }

  const entries = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^ {6}- '(.+)'$/.exec(line);
    if (entry !== null) {
      entries.push(entry[1]);
    } else if (!/^ {6}#/.test(line)) {
      break;
    }
  }
  return entries;
}

/** Every port a compose file publishes, with the service it belongs to. */
function publishedPortsOf(text) {
  return servicesOf(text).flatMap((service) =>
    portEntriesOf(blockOf(text, service)).map((entry) => ({ service, entry })),
  );
}

/** The `${NAME...}` variables an entry interpolates, in the order it writes them. */
function variablesOf(entry) {
  return [...entry.matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1]);
}

/**
 * That only the viewer's node answers a web page.
 *
 * A funded node carrying this flag is a page on any origin reading `/stamps` and getting the full
 * batch ids back, which `/health` truncates precisely because a batch id is the whole of what
 * authorises spending. The same page can then upload its own bytes against one of them, and the
 * first sign of it is a broadcast refused by the postage gate for a batch nobody here filled.
 */
describe('the Bee nodes a web page can talk to', () => {
  for (const file of BEE_COMPOSE_FILES) {
    it(`lets a browser reach ${BROWSER_FACING} and no other node in ${file}`, () => {
      const text = composeText(file);
      const answering = servicesOf(text).filter((service) => blockOf(text, service).includes(CORS_FLAG));

      assert.deepEqual(
        answering,
        [BROWSER_FACING],
        `${CORS_FLAG} belongs to the node a viewer's browser reads through and to no other. On a ` +
          `funded node it lets any page that can route to this host read its full postage batch ids ` +
          `and spend them. Carrying it in ${file}: ${answering.join(', ') || 'nothing'}`,
      );
    });
  }
});

/**
 * That every published port answers where a setting says, with a default somebody chose.
 *
 * Every listen address is a setting. Admin and file interfaces default to the host's Docker bridge,
 * because a firewall cannot close a port Docker publishes. Ingest, the viewer and the peer ports
 * default to every address, and which of those the internet reaches is the operator's firewall. The
 * open-by-default map carries each reason and is checked for stale keys below.
 */
describe('the published ports an operator can bind to one interface', () => {
  for (const file of PORT_COMPOSE_FILES) {
    const text = composeText(file);
    const published = publishedPortsOf(text);

    /**
     * That the reader above read the whole of every `ports:` list.
     *
     * Every quoted list entry in these files that interpolates a variable is a published port, so a
     * parser that stopped early or skipped a service is visible here rather than as an empty pass.
     */
    it(`reads every published port in ${file}`, () => {
      const declared = (text.match(/^ {6}- '\$\{[A-Z0-9_]+[^']*'$/gm) ?? []).map((line) => line.trim().slice(3, -1));
      const entries = published.map(({ entry }) => entry);
      const unread = declared.filter((entry) => !entries.includes(entry));

      assert.deepEqual(unread, [], `the ports reader did not see these, so the check below cannot judge them`);
      assert.ok(declared.length > 0, `no published port was found in ${file} at all`);
    });

    it(`offers a bind address for every published port in ${file}`, () => {
      const unbound = published
        .filter(({ entry }) => !/^\$\{[A-Z0-9_]+_BIND:-/.test(entry))
        .map(({ service, entry }) => `${service}: ${entry}`);

      assert.deepEqual(
        unbound,
        [],
        `these answer on every interface with no way to bind them, so an operator cannot choose ` +
          `where they answer: ${unbound.join(' | ')}`,
      );
    });

    it(`defaults every ingest, viewer and peer bind in ${file} to every address, and no other bind`, () => {
      const wrong = published
        .map(({ service, entry }) => ({ service, entry, bind: variablesOf(entry)[0] }))
        .filter(({ bind }) => !ADMIN_BINDS.has(bind))
        .filter(({ bind, entry }) => !OPEN_BY_DEFAULT.has(bind) || !entry.startsWith(`\${${bind}:-0.0.0.0}:`))
        .map(({ service, entry }) => `${service}: ${entry}`);

      assert.deepEqual(wrong, [], `a bind that is neither an admin one nor open by default: ${wrong.join(' | ')}`);
    });

    it(`gives every bind variable in ${file} a default, so an unset one still publishes`, () => {
      const withoutDefault = published
        .filter(({ entry }) => /\$\{[A-Z0-9_]*_BIND\}/.test(entry))
        .map(({ service, entry }) => `${service}: ${entry}`);

      assert.deepEqual(
        withoutDefault,
        [],
        `a bind variable with no :- default publishes a mapping starting with a colon when it is ` +
          `unset, which is every deployment that has not set it: ${withoutDefault.join(' | ')}`,
      );
    });
  }

  /**
   * That an admin or file interface left unset answers on the host's Docker bridge and nowhere else.
   *
   * A firewall cannot do this part. Docker publishes a port with rules of its own that a host firewall
   * such as ufw never sees, and a Bee API has no password and spends postage. So these default to the
   * bridge address `deploy.sh` reads at deploy time, and to the loopback address when compose runs
   * without it, never to every address. An explicit value still wins, because `:-` only fills an empty one.
   */
  it('defaults every admin and file interface to the bridge address, and to loopback without one', () => {
    const wrong = PORT_COMPOSE_FILES.flatMap((file) =>
      publishedPortsOf(composeText(file))
        .filter(({ entry }) => variablesOf(entry).some((name) => ADMIN_BINDS.has(name)))
        .filter(({ entry }) => !/^\$\{[A-Z0-9_]+_BIND:-\$\{DOCKER_BRIDGE_ADDRESS:-127\.0\.0\.1\}\}:/.test(entry))
        .map(({ service, entry }) => `${file} ${service}: ${entry}`),
    );
    const seen = new Set(
      PORT_COMPOSE_FILES.flatMap((file) =>
        publishedPortsOf(composeText(file)).flatMap(({ entry }) => variablesOf(entry)),
      ),
    );

    assert.deepEqual(wrong, [], 'these admin interfaces default to something other than the bridge address');
    assert.deepEqual(
      [...ADMIN_BINDS].filter((name) => !seen.has(name)),
      [],
      'an admin bind this check knows is published by no compose file, so it checks nothing for it',
    );
  });

  it('gives every Bee API the deploy\'s host-networking listen default, which is empty on a bridge network', () => {
    for (const file of BEE_COMPOSE_FILES) {
      const listens = composeText(file).match(/--api-addr=[^\n]*/g) ?? [];
      for (const listen of listens.filter((line) => line.includes('_API_LISTEN'))) {
        assert.match(listen, /^--api-addr=\$\{BEE_[A-Z0-9_]+_API_LISTEN:-\$\{HOST_NETWORK_LISTEN:-\}\}:/, `${file}: ${listen}`);
      }
    }
  });

  it('keeps no open-by-default bind that no longer names a published port', () => {
    const everyPortVariable = new Set(
      PORT_COMPOSE_FILES.flatMap((file) =>
        publishedPortsOf(composeText(file)).flatMap(({ entry }) => variablesOf(entry)),
      ),
    );
    const stale = [...OPEN_BY_DEFAULT.keys()].filter((name) => !everyPortVariable.has(name));

    assert.deepEqual(stale, [], `these are open by default and no compose file publishes them any more`);
  });
});
