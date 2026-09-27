import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import { isNodeUnavailable } from '../src/libs/NodeWait.js';
import { describeFailure, isTransferLost, transportCodeOf } from '../src/utils/transportFailure.js';

import { LOOPBACK_HOST } from './helpers/loopbackServer.js';

/**
 * Every transport failure a Bee node can hand the uploader, thrown by the real bee-js through the real
 * pool against a real socket, never built by hand.
 *
 * ⛔⛔⛔ **bee-js 13 moved every one of these.** bee-js 9 went through axios and put Node's code on
 * `statusText`: ECONNREFUSED, ECONNRESET, and ECONNABORTED for its own timeout and for a body cut short.
 * bee-js 13 goes through `fetch` and keeps no code at all. A refused or reset request keeps the code
 * only inside its message, "fetch failed: read ECONNRESET". A timeout says "The operation was aborted
 * due to timeout". A body cut short is not even a `BeeResponseError`: it is fetch's own
 * `TypeError: terminated`, with the code on its `cause`, ECONNRESET for a reset and UND_ERR_SOCKET for
 * a clean close. Measured 2026-09-27 on bee-js 9.8.1 and 13.1.0 against the same sockets. A fixture
 * written from what the code expected would have kept passing through all of it, which is why these
 * are taken from the library itself.
 */
type Failure = 'refused' | 'silent' | 'reset before answer' | 'reset mid-body' | 'closed mid-body';

const FAILURES: readonly Failure[] = ['refused', 'silent', 'reset before answer', 'reset mid-body', 'closed mid-body'];

/** Short, since the silent node spends all of it. */
const TIMEOUT_MS = 300;

const PARTIAL_ANSWER =
  'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"status":';

const servers: net.Server[] = [];

async function listen(onSocket: (socket: net.Socket) => void): Promise<string> {
  const server = net.createServer(onSocket);
  servers.push(server);
  server.listen(0, LOOPBACK_HOST);
  await once(server, 'listening');
  return `http://${LOOPBACK_HOST}:${(server.address() as AddressInfo).port}`;
}

async function closedPortUrl(): Promise<string> {
  const server = net.createServer();
  server.listen(0, LOOPBACK_HOST);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return `http://${LOOPBACK_HOST}:${port}`;
}

function nodeUrl(failure: Failure): Promise<string> {
  switch (failure) {
    case 'refused':
      return closedPortUrl();
    case 'silent':
      return listen(() => {});
    case 'reset before answer':
      return listen((socket) => socket.once('data', () => socket.resetAndDestroy()));
    case 'reset mid-body':
      return listen((socket) =>
        socket.once('data', () => {
          socket.write(PARTIAL_ANSWER);
          setTimeout(() => socket.resetAndDestroy(), 50);
        }),
      );
    case 'closed mid-body':
      return listen((socket) =>
        socket.once('data', () => {
          socket.write(PARTIAL_ANSWER);
          setTimeout(() => socket.end(), 50);
        }),
      );
  }
}

/** What the pool's client throws for a read of this node. */
async function thrownBy(failure: Failure): Promise<unknown> {
  const bee = BeePublisherPool.single(await nodeUrl(failure), 'a'.repeat(64), TIMEOUT_MS).coordinator().bee;
  try {
    await bee.status.getHealth();
  } catch (error) {
    return error;
  }
  throw new Error(`a read of a node that is ${failure} succeeded`);
}

/** How a start gate reports a node it could not read: its own sentence around the failure's words. */
function wrappedByAGate(error: unknown): Error {
  return new Error(`chequebook check could not read http://bee-a:1633: ${describeFailure(error)}`);
}

/** The code bee-js 9.8.1 put on `statusText` for each, measured against the same sockets. */
const BEE_JS_9_CODE: Record<Failure, string> = {
  refused: 'ECONNREFUSED',
  silent: 'ECONNABORTED',
  'reset before answer': 'ECONNRESET',
  'reset mid-body': 'ECONNRESET',
  'closed mid-body': 'ECONNABORTED',
};

/** A node that answers, and refuses: bee's 404 for a batch it does not hold. */
function answeringNotFound(): Promise<string> {
  const body = JSON.stringify({ code: 404, message: 'issuer does not exist' });
  return listen((socket) =>
    socket.once('data', () => {
      socket.end(
        `HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
      );
    }),
  );
}

const thrown = new Map<Failure, unknown>();
let notFound: unknown;

before(async () => {
  for (const failure of FAILURES) {
    thrown.set(failure, await thrownBy(failure));
  }
  const bee = BeePublisherPool.single(await answeringNotFound(), 'a'.repeat(64), TIMEOUT_MS).coordinator().bee;
  notFound = await bee.stamp.get('a'.repeat(64)).then(
    () => new Error('a node answering 404 returned a batch'),
    (error: unknown) => error,
  );
});

after(() => {
  for (const server of servers) {
    server.close();
  }
});

describe('the boot waits for a node that fails in transport, as bee-js 13 reports it', () => {
  for (const failure of FAILURES) {
    it(`waits on a node that is ${failure}`, () => {
      assert.equal(isNodeUnavailable(thrown.get(failure)), true, String(thrown.get(failure)));
    });

    it(`waits on a node that is ${failure}, once a start gate has put it in a sentence`, () => {
      const wrapped = wrappedByAGate(thrown.get(failure));
      assert.equal(isNodeUnavailable(wrapped), true, wrapped.message);
    });
  }
});

describe('the transport code of each failure, as bee-js 9 gave it', () => {
  for (const failure of FAILURES) {
    it(`is ${BEE_JS_9_CODE[failure]} for a node that is ${failure}`, () => {
      assert.equal(transportCodeOf(thrown.get(failure)), BEE_JS_9_CODE[failure], String(thrown.get(failure)));
    });
  }

  it('is nothing for a node that answered, and the boot does not wait on its refusal', () => {
    assert.equal((notFound as { status?: unknown }).status, 404, String(notFound));
    assert.equal(transportCodeOf(notFound), null);
    assert.equal(isNodeUnavailable(notFound), false);
    assert.equal(isNodeUnavailable(wrappedByAGate(notFound)), false);
  });
});

/**
 * Whether the catalog's boot read may resume from its persisted index: only when the node was reached
 * and the answer was lost on the way back. Under bee-js 9 that was ECONNABORTED or ECONNRESET with no
 * status, which covered the uploader's own timeout, both resets and a body closed early, and never a
 * refused connection or an answer.
 */
describe('a transfer lost on the way back, as the catalog reads it', () => {
  const LOST: readonly Failure[] = ['silent', 'reset before answer', 'reset mid-body', 'closed mid-body'];

  for (const failure of LOST) {
    it(`is a lost transfer for a node that is ${failure}`, () => {
      assert.equal(isTransferLost(thrown.get(failure)), true, String(thrown.get(failure)));
    });
  }

  it('is not a lost transfer for a node that refused the connection, which was never reached', () => {
    assert.equal(isTransferLost(thrown.get('refused')), false);
  });

  it('is not a lost transfer for a node that answered', () => {
    assert.equal(isTransferLost(notFound), false);
  });
});
