/**
 * Why the manager refused a chequebook transfer, in the words the page shows.
 *
 * The manager sets a cause where it decides to refuse and answers it with the
 * refusal. The page turns it back into a sentence. Both read the list and the
 * sentences from here, so a cause the manager can answer always has words on
 * the page, and nothing the page shows can come from upstream text.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHEQUEBOOK_PREFLIGHT_REFUSALS,
  CHEQUEBOOK_REFUSAL_CAUSES,
  chequebookPreflightSentence,
  chequebookRefusal,
  chequebookRefusalSentence,
  isChequebookPreflightRefusal,
  isChequebookRefusal,
} from './chequebookRefusals.js';

const EM_DASH = '\u2014';
function assertPlain(sentence: string): void {
  assert.equal(sentence.includes(EM_DASH), false, sentence);
  assert.equal(sentence.includes(';'), false, sentence);
}

const everyRefusal = () => CHEQUEBOOK_REFUSAL_CAUSES.map((cause) => chequebookRefusal(cause));

describe('chequebook refusal causes', () => {
  it('names at least the causes a transfer on a new host can meet', () => {
    for (const cause of [
      'bee_container_not_found',
      'chain_endpoint_missing',
      'chain_unreachable',
      'wrong_chain',
      'target_changed',
    ] as const) {
      assert.ok(CHEQUEBOOK_REFUSAL_CAUSES.includes(cause), cause);
    }
  });

  it('gives every cause a sentence of its own', () => {
    const sentences = everyRefusal().map(chequebookRefusalSentence);
    assert.equal(new Set(sentences).size, sentences.length, 'no two refusals read the same');
    for (const sentence of sentences) {
      assert.ok(sentence.length > 40, sentence);
      assert.ok(sentence.endsWith('.'), sentence);
    }
  });

  it('writes plain sentences, with no em-dash and no semicolon', () => {
    for (const sentence of everyRefusal().map(chequebookRefusalSentence)) assertPlain(sentence);
  });

  it('says that nothing was sent whenever the manager refused before recording the transfer', () => {
    for (const refusal of everyRefusal()) assert.match(chequebookRefusalSentence(refusal), /Nothing was sent\./);
  });

  it('names the setting to change when a manager setting is the cause', () => {
    for (const cause of ['chain_setting_invalid', 'chain_endpoint_missing'] as const) {
      const sentence = chequebookRefusalSentence(chequebookRefusal(cause));
      for (const setting of [/CHEQUEBOOK_RPC_ENDPOINTS/, /FUNDING_RPC_URL/, /BEE_RPC_ENDPOINT/]) {
        assert.match(sentence, setting, cause);
      }
    }
  });

  it('never sends the operator to Docker or ssh', () => {
    for (const cause of CHEQUEBOOK_REFUSAL_CAUSES) {
      const sentence = chequebookRefusalSentence(chequebookRefusal(cause));
      assert.doesNotMatch(sentence, /docker|ssh|endpoint the Bee node uses|started without/i, cause);
    }
  });

  it("names the reserved port when the recorded Bee API port is not the deployment's", () => {
    assert.match(chequebookRefusalSentence(chequebookRefusal('bee_container_unsupported')), /port .*reserved/);
  });

  it('carries its cause and nothing else, frozen', () => {
    assert.deepEqual(chequebookRefusal('wrong_chain'), { cause: 'wrong_chain' });
    assert.ok(Object.isFrozen(chequebookRefusal('wrong_chain')));
  });

  it('recognises only a refusal drawn from the closed list', () => {
    for (const refusal of everyRefusal()) assert.equal(isChequebookRefusal(refusal), true);
    for (const value of [
      null,
      undefined,
      'wrong_chain',
      {},
      { cause: 'not_a_cause' },
      { cause: 'Connection refused by 10.0.0.1' },
      { cause: 'wrong_chain', check: null },
      { cause: 'wrong_chain', detail: 'x' },
    ]) {
      assert.equal(isChequebookRefusal(value), false, JSON.stringify(value));
    }
  });
});

describe('chequebook preflight refusals', () => {
  it('keeps the existing reason and adds one for no gas and one for too little balance', () => {
    assert.deepEqual(
      [...CHEQUEBOOK_PREFLIGHT_REFUSALS],
      ['preflight_failed', 'preflight_no_gas', 'preflight_insufficient_balance'],
    );
    for (const reason of CHEQUEBOOK_PREFLIGHT_REFUSALS) assert.equal(isChequebookPreflightRefusal(reason), true);
    for (const value of ['response_unavailable', 'hash_conflict', null, 'preflight_no_gas '])
      assert.equal(isChequebookPreflightRefusal(value), false);
  });

  it('says which balance was short for each direction, in plain sentences', () => {
    assert.match(chequebookPreflightSentence('preflight_no_gas', 'deposit'), /xDAI/);
    assert.match(chequebookPreflightSentence('preflight_insufficient_balance', 'deposit'), /wallet/);
    assert.match(chequebookPreflightSentence('preflight_insufficient_balance', 'withdraw'), /chequebook/);
    for (const reason of CHEQUEBOOK_PREFLIGHT_REFUSALS) {
      for (const direction of ['deposit', 'withdraw'] as const) {
        const sentence = chequebookPreflightSentence(reason, direction);
        assertPlain(sentence);
        assert.match(sentence, /before (it was )?sent|before sending/, reason);
      }
    }
  });
});
