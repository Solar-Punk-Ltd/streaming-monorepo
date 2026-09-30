import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_QUALITY_LADDER } from '@streaming-monorepo/contracts';

import { abrLadderEnvValue } from './abrLadder.js';
import {
  ABR_LADDER_ENV_KEY,
  ABR_RUNG_SETTINGS,
  abrLadderOf,
  abrRungSettingKey,
  composedAbrLadderEnvValue,
} from './abrRungSettings.js';
import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import { effectiveEngineDefaults } from './engineDefaults.js';
import {
  engineOfSettingKey,
  engineSettingsEnv,
  engineSettingsFieldsFor,
  engineSettingsProblem,
  SRS_SETTINGS,
} from './engineSettings.js';

const ABR = { abr: true };
const PLAIN = { abr: false };

const key = abrRungSettingKey;

describe('the rung settings', () => {
  it('are a width, a height and a bitrate for every rung of the shipped ladder, grouped by rung', () => {
    assert.deepEqual(
      ABR_RUNG_SETTINGS.map((field) => field.key),
      DEFAULT_QUALITY_LADDER.flatMap((rung) => [
        key(rung.name, 'width'),
        key(rung.name, 'height'),
        key(rung.name, 'kbps'),
      ]),
    );
    assert.equal(ABR_RUNG_SETTINGS.length, DEFAULT_QUALITY_LADDER.length * 3);
  });

  it('default to the shipped ladder', () => {
    for (const rung of DEFAULT_QUALITY_LADDER) {
      const defaultOf = (name: string) => ABR_RUNG_SETTINGS.find((field) => field.key === name)?.defaultValue;
      assert.equal(defaultOf(key(rung.name, 'width')), String(rung.width));
      assert.equal(defaultOf(key(rung.name, 'height')), String(rung.height));
      assert.equal(defaultOf(key(rung.name, 'kbps')), String(rung.kbps));
    }
  });

  it('are SRS settings a deployment reads only while it encodes the ladder', () => {
    for (const field of ABR_RUNG_SETTINGS) {
      assert.ok(SRS_SETTINGS.includes(field), `${field.key} is an SRS setting`);
      assert.equal(field.abrOnly, true);
      assert.equal(engineOfSettingKey(field.key), SRS_SERVICE);
    }
    const plainKeys = engineSettingsFieldsFor(SRS_SERVICE, PLAIN).map((field) => field.key);
    assert.ok(!plainKeys.some((name) => name.startsWith('ABR_RUNG_')));
  });

  it('are composed into ABR_LADDER and carry no config token of their own', () => {
    for (const field of ABR_RUNG_SETTINGS) {
      assert.equal(field.composedInto, ABR_LADDER_ENV_KEY);
      assert.equal(field.placeholder, undefined);
    }
  });

  it('name the rung and the dimension in the label, with pixels or kbps as the unit', () => {
    const field = (name: string) => ABR_RUNG_SETTINGS.find((candidate) => candidate.key === name)!;
    assert.equal(field(key('1080p', 'width')).label, '1080p width');
    assert.equal(field(key('1080p', 'width')).unit, 'pixels');
    assert.equal(field(key('1080p', 'height')).label, '1080p height');
    assert.equal(field(key('1080p', 'kbps')).label, '1080p bitrate');
    assert.equal(field(key('1080p', 'kbps')).unit, 'kbps');
  });

  it('call the bitrate the target it is encoded at, which the encoder buffer turns into a ceiling', () => {
    const help = ABR_RUNG_SETTINGS.find((candidate) => candidate.key === key('720p', 'kbps'))!.help;
    assert.match(
      help,
      /^The bitrate the 720p video is encoded at, in kilobits per second, which the encoder buffer setting turns into a ceiling\./,
    );
  });
});

describe('ABR_LADDER composed from the rung settings', () => {
  it('is byte for byte the shipped value when nothing is stored', () => {
    assert.equal(composedAbrLadderEnvValue({}), abrLadderEnvValue());
    assert.equal(
      composedAbrLadderEnvValue({}),
      '1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700',
    );
  });

  it('takes a stored value over the default, rung by rung, highest rung first', () => {
    const settings = {
      [key('1080p', 'width')]: '2560',
      [key('1080p', 'height')]: '1440',
      [key('1080p', 'kbps')]: '8000',
      [key('360p', 'kbps')]: '600',
    };
    assert.equal(
      composedAbrLadderEnvValue(settings),
      '1080p:2560:1440:8000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:600',
    );
  });

  it('ignores the other engine settings', () => {
    assert.equal(composedAbrLadderEnvValue({ ABR_FPS: '25', HLS_FRAGMENT: '2' }), abrLadderEnvValue());
  });

  it('keeps the rung names fixed, lowest first', () => {
    assert.deepEqual(
      abrLadderOf({ [key('720p', 'height')]: '700' }).map((rung) => rung.name),
      DEFAULT_QUALITY_LADDER.map((rung) => rung.name),
    );
    assert.equal(abrLadderOf({ [key('720p', 'height')]: ' 700 ' })[2]!.height, 700);
  });
});

describe('engineSettingsEnv and the rung settings', () => {
  it('never writes a rung setting as a line of its own', () => {
    const stored = { [key('1080p', 'width')]: '2560', [key('480p', 'kbps')]: '1500', ABR_FPS: '25' };
    const lines = engineSettingsEnv(SRS_SERVICE, stored, ABR);
    assert.deepEqual(lines, { ABR_FPS: '25' });
  });

  it("writes none of them from the manager's own defaults either", () => {
    const defaults = effectiveEngineDefaults(SRS_SERVICE);
    const lines = engineSettingsEnv(SRS_SERVICE, {}, { abr: true, defaults });
    assert.ok(!Object.keys(lines).some((name) => name.startsWith('ABR_RUNG_')));
  });
});

describe('effectiveEngineDefaults and the rung settings', () => {
  it("names the shipped ladder as the manager's own default, whatever the host sets", () => {
    const defaults = effectiveEngineDefaults(
      SRS_SERVICE,
      { [key('1080p', 'width')]: '1280', ABR_LADDER: '1080p:1280:720:3000' },
      { [key('1080p', 'width')]: '1280' },
    );
    assert.equal(defaults.values[key('1080p', 'width')], '1920');
    assert.equal(defaults.sources[key('1080p', 'width')], 'manager');
    assert.deepEqual(defaults.rejected, []);
  });
});

describe('the rung checks', () => {
  it('accept the shipped ladder', () => {
    assert.equal(engineSettingsProblem(SRS_SERVICE, {}, ABR), null);
  });

  it('refuse an odd width or height, and say why', () => {
    const width = engineSettingsProblem(SRS_SERVICE, { [key('720p', 'width')]: '1279' }, ABR);
    assert.match(width!, /720p width must be an even number/);
    assert.match(width!, /odd/);
    assert.match(width!, /1279/);
    const height = engineSettingsProblem(SRS_SERVICE, { [key('360p', 'height')]: '361' }, ABR);
    assert.match(height!, /360p height must be an even number/);
  });

  it('refuse a fraction', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { [key('720p', 'kbps')]: '2800.5' }, ABR)!,
      /720p bitrate must be a whole number/,
    );
  });

  it('refuse a size or bitrate out of bounds, naming the bound', () => {
    assert.match(engineSettingsProblem(SRS_SERVICE, { [key('360p', 'width')]: '126' }, ABR)!, /at least 128/);
    assert.match(engineSettingsProblem(SRS_SERVICE, { [key('1080p', 'width')]: '3842' }, ABR)!, /at most 3840/);
    assert.match(engineSettingsProblem(SRS_SERVICE, { [key('360p', 'height')]: '70' }, ABR)!, /at least 72/);
    assert.match(engineSettingsProblem(SRS_SERVICE, { [key('1080p', 'height')]: '2162' }, ABR)!, /at most 2160/);
    assert.match(engineSettingsProblem(SRS_SERVICE, { [key('360p', 'kbps')]: '99' }, ABR)!, /at least 100/);
    assert.match(engineSettingsProblem(SRS_SERVICE, { [key('1080p', 'kbps')]: '20001' }, ABR)!, /at most 20000/);
  });

  it('accept the bounds themselves', () => {
    const settings = {
      [key('360p', 'width')]: '128',
      [key('360p', 'height')]: '72',
      [key('360p', 'kbps')]: '100',
      [key('1080p', 'width')]: '3840',
      [key('1080p', 'height')]: '2160',
      [key('1080p', 'kbps')]: '20000',
    };
    assert.equal(engineSettingsProblem(SRS_SERVICE, settings, ABR), null);
  });

  it('refuse a rung no taller than the one below it, naming both', () => {
    const problem = engineSettingsProblem(SRS_SERVICE, { [key('720p', 'height')]: '480' }, ABR);
    assert.match(problem!, /720p/);
    assert.match(problem!, /taller than the 480p rung/);
    assert.match(problem!, /480/);
  });

  it('refuse a rung whose bitrate is not above the one below it, against its default', () => {
    const problem = engineSettingsProblem(SRS_SERVICE, { [key('480p', 'kbps')]: '2800' }, ABR);
    assert.match(problem!, /720p/);
    assert.match(problem!, /higher bitrate than the 480p rung/);
  });

  it('accept a whole ladder moved up together', () => {
    const settings = {
      [key('360p', 'width')]: '854',
      [key('360p', 'height')]: '480',
      [key('480p', 'width')]: '1280',
      [key('480p', 'height')]: '720',
      [key('720p', 'width')]: '1920',
      [key('720p', 'height')]: '1080',
      [key('1080p', 'width')]: '2560',
      [key('1080p', 'height')]: '1440',
      [key('1080p', 'kbps')]: '8000',
    };
    assert.equal(engineSettingsProblem(SRS_SERVICE, settings, ABR), null);
  });

  it('refuse a rung setting on a deployment that does not encode the ladder', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { [key('720p', 'width')]: '1280' }, PLAIN)!,
      /only applies to a deployment that encodes the ABR ladder/,
    );
  });

  it('are not settings OvenMediaEngine reads', () => {
    assert.match(
      engineSettingsProblem(OME_SERVICE, { [key('720p', 'width')]: '1280' }, PLAIN)!,
      /not a setting the ome engine reads/,
    );
  });
});
