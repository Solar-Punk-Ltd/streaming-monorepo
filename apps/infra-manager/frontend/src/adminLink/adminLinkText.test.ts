/**
 * What the page says for each outcome of Test connection: one plain sentence
 * each, and how loudly it says it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADMIN_LINK_TEST_OUTCOMES } from '@streaming-infra-manager/common';

import {
  ADMIN_LINK_OFF_NOTE,
  ADMIN_LINK_TEST_REACH,
  adminLinkTestSeverity,
  adminLinkTestText,
  OWN_TOKEN_TITLE,
  ownTokenDetail,
} from './adminLinkText';

describe('the sentence for each Test connection outcome', () => {
  it('has one plain sentence for every outcome, with no dash or semicolon', () => {
    for (const outcome of ADMIN_LINK_TEST_OUTCOMES) {
      const text = adminLinkTestText(outcome);
      assert.match(text, /^[A-Z].*\.$/, outcome);
      assert.equal(text.split(/\.\s/).length, 1, `${outcome} is one sentence: ${text}`);
      assert.doesNotMatch(text, /[—;]/, outcome);
    }
  });

  it('says what each outcome means for the uploader', () => {
    assert.equal(
      adminLinkTestText('linked'),
      "Linked: the web2 admin took the token and knows this deployment's stream address as the owner its streams are signed as.",
    );
    assert.equal(adminLinkTestText('token-refused'), 'The web2 admin answered but refused the token.');
    assert.equal(adminLinkTestText('unreachable'), 'The web2 admin did not answer from where the manager runs.');
    assert.equal(
      adminLinkTestText('stored-token-elsewhere'),
      'The stored token was saved for another address, so it was not sent here, and the token has to be typed again for this address.',
    );
    assert.equal(
      adminLinkTestText('owner-mismatch'),
      "The web2 admin took the token but knows another owner for this deployment than its stream key's address, so the uploader will refuse to start.",
    );
  });

  it('says a success quietly and a refusal loudly', () => {
    assert.equal(adminLinkTestSeverity('linked'), 'success');
    assert.equal(adminLinkTestSeverity('token-accepted'), 'success');
    assert.equal(adminLinkTestSeverity('owner-unconfirmed'), 'warning');
    assert.equal(adminLinkTestSeverity('token-not-registered'), 'warning');
    assert.equal(adminLinkTestSeverity('not-linked'), 'info');
    for (const outcome of [
      'owner-mismatch',
      'token-refused',
      'not-admin',
      'redirected',
      'unreachable',
      'invalid-address',
      'no-token',
      'stored-token-elsewhere',
    ] as const) {
      assert.equal(adminLinkTestSeverity(outcome), 'error', outcome);
    }
  });

  it("says what the wizard's switch does in each position, and that the deployment gets a token of its own", () => {
    assert.equal(
      ADMIN_LINK_OFF_NOTE,
      'Off, this deployment stores an empty ADMIN_API_URL, so its uploader runs standalone even when its version turns admin mode on.',
    );
    assert.equal(OWN_TOKEN_TITLE, 'A token of its own');
    assert.equal(
      ownTokenDetail(true),
      "This deployment gets a token of its own: the manager generates it at the first deploy and registers it with the web2 admin before the uploader starts. It never reaches this page, and Test connection uses the manager's stored token.",
    );
    assert.equal(
      ownTokenDetail(false),
      'The manager has no web2 admin link with a token to register one with. Save the link on Manager settings, or type a token here.',
    );
  });

  it('says in one line where the test runs from', () => {
    assert.equal(
      ADMIN_LINK_TEST_REACH,
      "The test runs from where the manager runs, so an address only the deployment's own network can reach reads as unreachable here.",
    );
  });
});
