import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { managedRungTopicFor } from '../../src/domain/managedRungTopic.js';

interface TopicFixture {
  topicDerivation: {
    declaredTopic: string;
    rungs: Array<{ name: string; topic: string }>;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../common/fixtures/uploader-capabilities-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as TopicFixture;

describe('managed rung topic derivation', () => {
  it('matches the uploader capability fixture', () => {
    for (const rung of fixture.topicDerivation.rungs) {
      assert.equal(
        managedRungTopicFor(fixture.topicDerivation.declaredTopic, rung.name),
        rung.topic,
      );
    }
  });
});
