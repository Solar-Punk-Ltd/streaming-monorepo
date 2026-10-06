/**
 * The feed topic on the wizard's create body.
 *
 * Unit test, no DOM, the request captured off a mocked fetch the way the node
 * mode submission test does it. `pnpm test` in frontend/.
 *
 * The client builds the topic into its bundle beside the owner, so a topic the
 * operator typed and the body left out is a player that follows the right
 * streamer on the wrong feed, and nothing on the page would say so.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackVersion } from '@streaming-infra-manager/common';

import { initialWizardState, type WizardContext, type WizardGoal, type WizardState } from './wizardState';
import { submitWizard } from './wizardSubmit';

const OWNER = '0x1111111111111111111111111111111111111111';

const context: WizardContext = {
  profiles: [],
  groups: [],
  serverHost: 'fixture.test',
  hostPassphrase: null,
  beeRpcEndpoint: { configured: false, host: null },
  poolResults: new Map(),
  versions: [{ id: 7, status: 'ready', isDefault: true, tested: true } as StackVersion],
};

interface SentRequest {
  path: string;
  body: Record<string, unknown>;
}

function stateFor(goal: WizardGoal, over: Partial<WizardState> = {}): WizardState {
  return {
    ...initialWizardState({ goal }, context),
    name: 'watch1',
    feedMode: 'paste',
    feedOwner: OWNER,
    ...over,
  };
}

/** Where the wizard sent its one request, and what it put in it. */
async function sentRequest(
  t: { mock: { method: typeof import('node:test').mock.method } },
  state: WizardState,
): Promise<SentRequest> {
  let sent: SentRequest | null = null;
  t.mock.method(globalThis, 'fetch', async (path: unknown, init: RequestInit) => {
    sent = {
      path: String(path),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({ name: 'watch1' }), { status: 202 });
  });
  // A group builds its outcome from a whole valid response, which is another
  // test's subject. The request has already gone by the time that is read.
  await submitWizard(state, context).catch(() => undefined);
  if (!sent) throw new Error('the wizard sent no request');
  return sent;
}

describe('the feed topic on the wizard create body', () => {
  it('is the topic typed for a viewer, without the spaces around it', async (t) => {
    const { body } = await sentRequest(t, stateFor('viewer', { feedTopic: ' brand.catalog_1 ' }));

    assert.equal(body.feed_topic, 'brand.catalog_1');
    assert.equal(body.feed_owner, OWNER);
  });

  it('is absent when the field was left empty, which is the stack version’s own topic', async (t) => {
    const { body } = await sentRequest(t, stateFor('viewer', { feedTopic: '  ' }));

    assert.equal('feed_topic' in body, false);
  });

  it('goes to every member of a viewer group', async (t) => {
    const { path, body } = await sentRequest(t, stateFor('viewer', { group: true, feedTopic: 'brand.catalog_1' }));

    assert.match(path, /\/groups$/);
    assert.equal(body.feed_topic, 'brand.catalog_1');
  });

  it('goes with a custom deployment that runs the client', async (t) => {
    const { body } = await sentRequest(t, stateFor('custom', { feedTopic: 'brand.catalog_1' }));

    assert.equal(body.feed_topic, 'brand.catalog_1');
  });

  /**
   * Only the client reads it, so a topic left behind by a visit to a goal that
   * has one is not stored where nothing uses it.
   */
  it('is absent where no client runs to read it', async (t) => {
    const stream = await sentRequest(t, stateFor('stream', { feedTopic: 'brand.catalog_1' }));
    const custom = await sentRequest(t, stateFor('custom', { components: ['srs'], feedTopic: 'brand.catalog_1' }));

    assert.equal('feed_topic' in stream.body, false);
    assert.equal('feed_topic' in custom.body, false);
  });
});
