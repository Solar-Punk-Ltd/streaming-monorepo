/**
 * How the cards and the wizard's review name the topic a player follows when
 * its deployment sets none.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * An unset topic is not "none": the player follows the one its version builds
 * the client with, and a page that said "none" would send an operator who
 * compares it with the admin's `feed.topic` looking for a fault that is not there.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { defaultFeedTopicText, STACK_FEED_TOPIC, versionFeedTopic } from './feedTopicText';

/** One row of a version's settings list, with only what the topic is read from filled in. */
function entry(key: string, versionValue: string | null): DeploymentSettingEntry {
  return { key, versionValue, versionSet: versionValue !== null } as DeploymentSettingEntry;
}

describe('the topic a version gives a player that names none', () => {
  it('is what the version sets for the key the client is built from', () => {
    const entries = [entry('STREAM_LIST_TOPIC', 'brand-uploads'), entry('VITE_APP_RAW_TOPIC', 'brand.catalog_1')];

    assert.equal(versionFeedTopic(entries), 'brand.catalog_1');
  });

  it('is the stack’s own fallback where the version sets nothing there, an empty value included', () => {
    assert.equal(versionFeedTopic([entry('VITE_APP_RAW_TOPIC', null)]), STACK_FEED_TOPIC);
    assert.equal(versionFeedTopic([entry('VITE_APP_RAW_TOPIC', '')]), STACK_FEED_TOPIC);
    assert.equal(versionFeedTopic([]), STACK_FEED_TOPIC);
  });

  it('is unknown while the version’s list has not been read', () => {
    assert.equal(versionFeedTopic(null), null);
    assert.equal(versionFeedTopic(undefined), null);
  });
});

describe('how a page names that topic', () => {
  it('names it, marked as the default, once it is known', () => {
    assert.equal(defaultFeedTopicText('swarm-stream'), 'swarm-stream (default)');
  });

  it('says it is the version’s default while it is not known', () => {
    assert.equal(defaultFeedTopicText(null), "the version's default");
  });
});
