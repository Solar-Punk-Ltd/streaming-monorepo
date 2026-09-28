/**
 * The catalogue node's address stays out of what a failed write tells the console. Unit test: the text rule on its
 * own, and the Bee gateway's thumbnail check with `fetch` stood in for. `pnpm test`.
 *
 * bee-js and Node print the address they failed to reach, whole as a URL or as `host:port` after a network error code.
 * The console is never told the Bee API address, so it is replaced with "the catalogue node" before a reason is stored
 * or answered.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { BeeFeedGateway } from '../../src/domain/BeeFeedGateway.js';
import { withoutCatalogueNode } from '../../src/domain/catalogueNodeText.js';
import { ThumbnailCheckError } from '../../src/domain/errors/index.js';

const target = { beeApiUrl: 'http://192.0.2.30:10025', batchId: 'c2'.repeat(32) };

describe('withoutCatalogueNode', () => {
  it('replaces the address after a network error code', () => {
    assert.equal(
      withoutCatalogueNode('fetch failed: connect ECONNREFUSED 192.0.2.30:10025', target),
      'fetch failed: connect ECONNREFUSED the catalogue node',
    );
    assert.equal(
      withoutCatalogueNode('getaddrinfo ENOTFOUND catalogue.example.org'),
      'getaddrinfo ENOTFOUND the catalogue node',
    );
    assert.equal(
      withoutCatalogueNode('connect EHOSTUNREACH [2001:db8::1]:1633'),
      'connect EHOSTUNREACH the catalogue node',
    );
    assert.equal(
      withoutCatalogueNode('connect ETIMEDOUT 198.51.100.4:1633 after 30s'),
      'connect ETIMEDOUT the catalogue node after 30s',
    );
  });

  it('replaces a URL whole, path and query included, whether or not it is the target', () => {
    assert.equal(
      withoutCatalogueNode('Request failed: http://192.0.2.30:10025/feeds/ab/cd?type=sequence', target),
      'Request failed: the catalogue node',
    );
    assert.equal(
      withoutCatalogueNode('GET https://bee.example.org/bzz/ee/ answered 500'),
      'GET the catalogue node answered 500',
    );
  });

  it("replaces the target's host and port wherever else they appear", () => {
    assert.equal(withoutCatalogueNode('node 192.0.2.30:10025 refused', target), 'node the catalogue node refused');
    assert.equal(withoutCatalogueNode('no route to 192.0.2.30', target), 'no route to the catalogue node');
  });

  it('leaves a message with no address as it was', () => {
    assert.equal(withoutCatalogueNode('the node answered 502', target), 'the node answered 502');
  });
});

describe('BeeFeedGateway.hasReference', () => {
  afterEach(() => mock.restoreAll());

  it("answers an unreachable node with a ThumbnailCheckError that does not name the node's address", async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 192.0.2.30:10025');
    });
    const gateway = new BeeFeedGateway({
      // Hardhat's first test account: public, and it signs nothing that matters.
      feedPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      feedTopic: 'catalogue-node-text-test',
    });

    await assert.rejects(gateway.hasReference('e'.repeat(64), target), (error: unknown) => {
      assert.ok(error instanceof ThumbnailCheckError);
      assert.equal(error.message.includes('192.0.2.30'), false, error.message);
      assert.match(error.message, /ECONNREFUSED the catalogue node$/);
      return true;
    });
  });
});
