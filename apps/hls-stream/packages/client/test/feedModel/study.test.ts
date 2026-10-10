import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { followPredicted, PREDICTED_DEFAULTS } from '../../src/components/SwarmHlsPlayer/following/followPredicted';

import { EarlyAskPenalty, NO_PENALTY } from './beeNode';
import { followAfterSegment } from './followAfterSegment';
import { followImmediately, TODAY_TRIGGER } from './followImmediately';
import { NodeProfile, PROFILE_A, PROFILE_B } from './profiles';
import { Finder, FindScenario, Follower, FollowScenario, runFind, runFollow } from './runs';
import { FindSummary, FollowSummary, summariseFind, summariseFollow } from './summaries';

/**
 * The full comparison behind the polling study. Skipped unless `FEED_STUDY` names a file to write the
 * tables to, because it runs for minutes: `FEED_STUDY=/tmp/study.md pnpm vitest run test/feedModel/study.test.ts`.
 * `FEED_SEEDS` sets the seeds per configuration, 200 unless given.
 */
const OUT = process.env.FEED_STUDY;
const SEEDS = Number(process.env.FEED_SEEDS ?? 200);
/** Which parts to run, all unless `FEED_PARTS` names some of validate, follow, pause, pair and find. */
const PARTS = new Set((process.env.FEED_PARTS ?? 'validate,follow,pause,pair,find').split(','));

const FOLLOWERS: Record<string, Follower> = {
  today: (context) => followImmediately(context),
  'wait a segment': (context) => followAfterSegment(context),
  predicted: (context) => followPredicted(context),
  'predicted, polls trigger': (context) => followPredicted(context, { ...PREDICTED_DEFAULTS, trigger: TODAY_TRIGGER }),
  'predicted, early 10 %': (context) => followPredicted(context, { ...PREDICTED_DEFAULTS, earlyRate: 0.1 }),
  'predicted, early 50 %': (context) => followPredicted(context, { ...PREDICTED_DEFAULTS, earlyRate: 0.5 }),
  'predicted, backoff to 8 s': (context) => followPredicted(context, { ...PREDICTED_DEFAULTS, maxBackoffMs: 8_000 }),
  'predicted, backoff to 30 s': (context) => followPredicted(context, { ...PREDICTED_DEFAULTS, maxBackoffMs: 30_000 }),
};

const penalty = (asks: number | null, from: 'first' | 'latest' = 'first'): EarlyAskPenalty =>
  asks === null ? NO_PENALTY : { asks, from };
const penaltyName = (value: EarlyAskPenalty) =>
  value.asks === null ? 'none' : `${value.asks}${value.from === 'latest' ? ' latest' : ''}`;

const BASE_FOLLOW: FollowScenario = {
  profile: PROFILE_A,
  coalescing: 0.1,
  clockOffsetMs: 0,
  penalty: NO_PENALTY,
  pause: null,
  durationMs: 600_000,
  start: 'pinned',
};

async function follow(scenario: FollowScenario, follower: Follower): Promise<FollowSummary> {
  const outcomes = [];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    outcomes.push(await runFollow(seed, scenario, follower));
  }
  return summariseFollow(outcomes);
}

async function find(scenario: FindScenario, finder: Finder): Promise<FindSummary> {
  const outcomes = [];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    outcomes.push(await runFind(seed, scenario, finder));
  }
  return summariseFind(outcomes);
}

const ms = (value: number) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'n/a');
const one = (value: number) => value.toFixed(1);
const two = (value: number) => value.toFixed(2);
const percent = (value: number) => `${Math.round(value * 100)} %`;

const FOLLOW_HEADER =
  '| case | follower | requests a minute | early asks per index | readable to found p50 / p90 / p99 ms | longest wait median run / worst ms | stalls an hour | stalled s an hour | skipped an hour |\n' +
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
const followRow = (label: string, name: string, s: FollowSummary) =>
  `| ${label} | ${name} | ${one(s.requestsPerMinute)} | ${two(s.earlyAsksPerIndex)} | ${ms(s.readableToFound.p50)} / ${ms(s.readableToFound.p90)} / ${ms(s.readableToFound.p99)} | ${ms(s.longestGap.median)} / ${ms(s.longestGap.max)} | ${one(s.stallsPerHour)} | ${one(s.stalledSecondsPerHour)} | ${one(s.skippedPerHour)} |`;

const FIND_HEADER =
  '| case | finder | reads p50 / p90 | early asks p50 / p90 | early asks left on the next slot, mean / max | rounds p50 / p90 | time p50 / p90 / worst ms | correct | fallback |\n' +
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
const findRow = (label: string, name: string, s: FindSummary) =>
  `| ${label} | ${name} | ${s.reads.p50} / ${s.reads.p90} | ${s.earlyAsks.p50} / ${s.earlyAsks.p90} | ${two(s.nextSlotEarlyAsks.mean)} / ${s.nextSlotEarlyAsks.max} | ${s.rounds.p50} / ${s.rounds.p90} | ${ms(s.timeMs.p50)} / ${ms(s.timeMs.p90)} / ${ms(s.timeMs.max)} | ${percent(s.correct)} | ${percent(s.fallbacks)} |`;

describe.skipIf(!OUT)('the polling study', () => {
  it('writes every table', { timeout: 6 * 3_600_000 }, async () => {
    const out: string[] = [`Seeds per configuration: ${SEEDS}. Ten simulated minutes per seed when following.`, ''];
    const started = Date.now();

    if (PARTS.has('validate')) {
      out.push("## Validation, today's walk against phase 0", '');
      out.push(
        '| profile | reads per slot 1 / 2 / 3 / 4+ | requests a minute | gap between finds p10 / p50 / p90 / worst ms |',
        '| --- | --- | --- | --- |',
      );
      for (const profile of [PROFILE_A, PROFILE_B]) {
        const outcomes = [];
        for (let seed = 1; seed <= SEEDS; seed += 1) {
          outcomes.push(await runFollow(seed, { ...BASE_FOLLOW, profile, coalescing: 0 }, FOLLOWERS.today));
        }
        const s = summariseFollow(outcomes);
        const gaps = outcomes.flatMap((outcome) => outcome.deliveryGapsMs).sort((a, b) => a - b);
        const at = (p: number) => gaps[Math.min(gaps.length - 1, Math.ceil(p * gaps.length) - 1)];
        out.push(
          `| ${profile.name} | ${s.readsPerSlotShares.map(percent).join(' / ')} | ${one(s.requestsPerMinute)} | ${ms(at(0.1))} / ${ms(at(0.5))} / ${ms(at(0.9))} / ${ms(gaps.at(-1)!)} |`,
        );
      }
    }
    if (PARTS.has('follow')) {
      out.push('', '## Following one feed', '', FOLLOW_HEADER);
      for (const profile of [PROFILE_A, PROFILE_B]) {
        for (const name of Object.keys(FOLLOWERS)) {
          out.push(
            followRow(
              `profile ${profile.name}, coalescing 10 %`,
              name,
              await follow({ ...BASE_FOLLOW, profile }, FOLLOWERS[name]),
            ),
          );
        }
      }
      for (const coalescing of [0, 0.3]) {
        for (const name of ['today', 'wait a segment', 'predicted']) {
          out.push(
            followRow(
              `coalescing ${percent(coalescing)}`,
              name,
              await follow({ ...BASE_FOLLOW, coalescing }, FOLLOWERS[name]),
            ),
          );
        }
      }
      for (const clockOffsetMs of [3_000, -3_000, 60_000, -60_000]) {
        for (const name of ['today', 'predicted']) {
          out.push(
            followRow(
              `viewer clock ${clockOffsetMs / 1_000} s`,
              name,
              await follow({ ...BASE_FOLLOW, clockOffsetMs }, FOLLOWERS[name]),
            ),
          );
        }
      }
      for (const asks of [4, 8, 16, 32]) {
        for (const name of ['today', 'wait a segment', 'predicted', 'predicted, polls trigger']) {
          out.push(
            followRow(
              `penalty k ${asks}`,
              name,
              await follow({ ...BASE_FOLLOW, penalty: penalty(asks) }, FOLLOWERS[name]),
            ),
          );
        }
      }
    }
    if (PARTS.has('pause')) {
      out.push('', '## A break in the broadcast five minutes in', '');
      out.push(
        '| pause | penalty k | follower | requests a minute | early asks per index | resume delay p50 / p90 / worst ms |',
        '| --- | --- | --- | --- | --- | --- |',
      );
      for (const lengthMs of [20_000, 120_000]) {
        for (const pen of [penalty(null), penalty(8), penalty(4), penalty(8, 'latest')]) {
          for (const name of ['today', 'predicted', 'predicted, backoff to 8 s', 'predicted, backoff to 30 s']) {
            const s = await follow(
              { ...BASE_FOLLOW, penalty: pen, pause: { afterMs: 300_000, lengthMs } },
              FOLLOWERS[name],
            );
            out.push(
              `| ${lengthMs / 1_000} s | ${penaltyName(pen)} | ${name} | ${one(s.requestsPerMinute)} | ${two(s.earlyAsksPerIndex)} | ${ms(s.resumeDelay!.p50)} / ${ms(s.resumeDelay!.p90)} / ${ms(s.resumeDelay!.max)} |`,
            );
          }
        }
      }
    }
    if (PARTS.has('pair')) {
      out.push('', '## Finding the head and then following it', '');
      out.push(
        '| profile | penalty k | start, then follower | early asks on the first slot mean / max | first slot readable to found p50 / p90 / p99 ms | requests a minute |',
        '| --- | --- | --- | --- | --- | --- |',
      );
      const pairs: Array<[string, FollowScenario['start'], string]> = [
        ["Bee's lookup, then today", 'bee', 'today'],
        ['search from nothing, then today', 'scratch', 'today'],
        ['search from nothing, then predicted', 'scratch', 'predicted'],
      ];
      for (const profile of [PROFILE_A, PROFILE_B]) {
        for (const pen of [penalty(null), penalty(4), penalty(8)]) {
          for (const [label, start, name] of pairs) {
            const outcomes = [];
            for (let seed = 1; seed <= SEEDS; seed += 1) {
              outcomes.push(
                await runFollow(
                  seed,
                  { ...BASE_FOLLOW, profile, penalty: pen, start, durationMs: 120_000 },
                  FOLLOWERS[name],
                ),
              );
            }
            const s = summariseFollow(outcomes);
            const first = summariseFollow(
              outcomes.map((outcome) => ({ ...outcome, readableToFoundMs: outcome.readableToFoundMs.slice(0, 1) })),
            );
            out.push(
              `| ${profile.name} | ${penaltyName(pen)} | ${label} | ${two(s.firstSlotEarlyAsks.mean)} / ${s.firstSlotEarlyAsks.max} | ${ms(first.readableToFound.p50)} / ${ms(first.readableToFound.p90)} / ${ms(first.readableToFound.p99)} | ${one(s.requestsPerMinute)} |`,
            );
          }
        }
      }
    }
    if (PARTS.has('find')) {
      out.push('', '## Finding the newest index', '', FIND_HEADER);
      const baseFind = (profile: NodeProfile, length: number): FindScenario => ({
        profile,
        length,
        divergence: 0,
        coalescing: 0.1,
        clockOffsetMs: 0,
        penalty: NO_PENALTY,
      });
      for (const profile of [PROFILE_A, PROFILE_B]) {
        for (const length of [300, 3_000, 18_000, 60_000]) {
          for (const finder of ['bee', 'scratch'] as const) {
            out.push(
              findRow(
                `profile ${profile.name}, length ${length}`,
                finder,
                await find(baseFind(profile, length), finder),
              ),
            );
          }
        }
      }
      for (const clockOffsetMs of [3_000, -3_000, 60_000, -60_000]) {
        for (const length of [300, 18_000]) {
          out.push(
            findRow(
              `length ${length}, viewer clock ${clockOffsetMs / 1_000} s`,
              'scratch',
              await find({ ...baseFind(PROFILE_A, length), clockOffsetMs }, 'scratch'),
            ),
          );
        }
      }
      for (const coalescing of [0, 0.3]) {
        for (const length of [18_000, 60_000]) {
          out.push(
            findRow(
              `length ${length}, coalescing ${percent(coalescing)}`,
              'scratch',
              await find({ ...baseFind(PROFILE_A, length), coalescing }, 'scratch'),
            ),
          );
        }
      }
      for (const profile of [PROFILE_A, PROFILE_B]) {
        for (const divergence of [0, 5, 50, 500]) {
          for (const sign of [1, -1]) {
            if (divergence === 0 && sign === -1) {
              continue;
            }
            const scenario = { ...baseFind(profile, 18_000), divergence: sign * divergence };
            out.push(
              findRow(
                `profile ${profile.name}, switch, target ${sign * divergence} from playing`,
                'hint',
                await find(scenario, 'hint'),
              ),
            );
          }
        }
      }
      for (const clockOffsetMs of [60_000, -60_000]) {
        out.push(
          findRow(
            `switch, target 5 ahead, viewer clock ${clockOffsetMs / 1_000} s`,
            'hint',
            await find({ ...baseFind(PROFILE_A, 18_000), divergence: 5, clockOffsetMs }, 'hint'),
          ),
        );
      }
      out.push(
        findRow(
          'switch, target 50 ahead, coalescing 30 %',
          'hint',
          await find({ ...baseFind(PROFILE_A, 18_000), divergence: 50, coalescing: 0.3 }, 'hint'),
        ),
      );
      out.push(
        findRow(
          'switch, target 5 ahead, length 300',
          'hint',
          await find({ ...baseFind(PROFILE_A, 300), divergence: 5 }, 'hint'),
        ),
      );
    }

    out.push('', `Ran in ${Math.round((Date.now() - started) / 1_000)} s.`);
    writeFileSync(OUT!, out.join('\n') + '\n');
  });
});
