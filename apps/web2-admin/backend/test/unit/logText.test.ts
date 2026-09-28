/**
 * `quoteForLog`, the one way free text gets into a log line. A log reader
 * that splits on more than `\n`, or a terminal that obeys C1 controls, must
 * not be able to see a line the backend did not write.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { quoteForLog } from '../../src/utils/logText.js';

describe('quoteForLog', () => {
  it('writes the text as a JSON string', () => {
    assert.equal(quoteForLog('Opening keynote'), '"Opening keynote"');
    assert.equal(quoteForLog('say "hi"\n'), '"say \\"hi\\"\\n"');
  });

  it('escapes every character a log reader could take for a line break', () => {
    assert.equal(quoteForLog('a\u2028b\u2029c\u0085d'), '"a\\u2028b\\u2029c\\u0085d"');
  });

  it('escapes C1 controls, DEL and the bidirectional controls', () => {
    assert.equal(quoteForLog('\u009b31m\u007f\u202eevil\u2066'), '"\\u009b31m\\u007f\\u202eevil\\u2066"');
  });

  it('keeps the text recoverable', () => {
    const text = 'x\u2028[INFO] y\u202e\u0085z "q" \\ \n';
    assert.equal(JSON.parse(quoteForLog(text)), text);
  });

  it('leaves ordinary non-ASCII text alone', () => {
    assert.equal(quoteForLog('Café 東京 ✓'), '"Café 東京 ✓"');
  });
});
