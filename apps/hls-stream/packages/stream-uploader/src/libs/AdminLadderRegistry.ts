import { Rendition } from '../types.js';

import { ADMIN_STATE_VOD, AdminApiClient, RenditionReportResponse } from './AdminApiClient.js';
import { hasRecording, isFinishedLadder, recordedRungs, recordingDuration } from './LadderCompletion.js';
import { LadderIdentity, LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';

interface AdminLadderRegistryOptions {
  client: AdminApiClient;
}

const NO_RUNGS: ReadonlySet<string> = new Set();

/**
 * The ladder registry admin mode uses: the admin holds the merge state.
 *
 * ## What moves
 *
 * Standalone, `StreamCatalog` holds one entry per ladder on the stream list feed and merges each rung's
 * record into it. Admin mode moves the merge into the admin's database: each rung posts its own record,
 * the admin merges it by the rule `StreamCatalog.keepingWhatFinished` states (a rung that has already
 * finished stays finished when it reports again without a recording), stores it, writes `renditions`
 * into its own catalog entry, and answers with the merged ladder. A player builds the ladder's master
 * playlist from those renditions.
 *
 * ⛔ **It holds no catalog and no catalog feed writer, and that is structural rather than a
 * convention.** The one rule admin mode has never been allowed to break is that this service writes
 * no stream catalog entry, and a registry that could reach one is a registry a later change can make
 * write one.
 *
 * ⛔ **The admin has to accept `live` after `vod`, and a rung's stable topic is why.** A declared
 * stream is one ladder for the life of the declaration, and its rungs' topics outlive their sessions:
 * a broadcaster who stops and comes back is a ladder going `live` again under a stream the admin
 * already holds as `vod`. The admin ships that transition on its own branch, and this service simply
 * reports what happened.
 *
 * ## Why the flip is read off the stream's status as well as off `flippedToFinished`
 *
 * The admin flips `flippedToFinished` once, on the report that completed the merge, and a report that
 * reached the admin and failed on this side afterwards loses that flip: the retry is answered with a
 * ladder that is already finished and no flip. Handed back as-is, that is a broadcast that stays
 * `live` in the admin's list for good. So a finished ladder whose stream the admin does not yet hold as
 * `vod` is reported as a flip too: the admin accepts `vod -> vod`, so saying it twice costs a round
 * trip, and saying it never costs the recording its listing.
 *
 * ## Why a rung that will not finish is judged here and not by the admin
 *
 * The admin counts a ladder finished only when every rung it holds has a recording, and its rendition
 * route refuses any field it does not know, so it cannot be told that a rung will not finish. On
 * 2026-09-23 that rung was 1080p, whose batch refused its recording, and the ladder never finished.
 * So this registry holds the mark itself, judges the ladder by `LadderCompletion`, and reports the flip
 * off that judgement and the status the admin holds.
 */
export class AdminLadderRegistry implements LadderRegistry {
  private readonly client: AdminApiClient;

  /**
   * Rungs this process knows will not finish, by group. See {@link recordRungUnfinished}.
   *
   * ⚠️ In memory only, which is enough for the one decision it serves: whether the broadcast that rung
   * belonged to has finished. Cleared once the admin holds the stream as `vod`, because a declared
   * stream is one ladder for many broadcasts, and a mark kept into the next one would list it as a
   * recording before its own rungs finished.
   */
  private readonly unfinished = new Map<string, Set<string>>();

  constructor(options: AdminLadderRegistryOptions) {
    this.client = options.client;
  }

  /**
   * Report this rung to the admin and say what that achieved.
   *
   * ⛔ **Throws when the report fails, because the caller has to treat it exactly as a failed catalog
   * announce.** `StreamUploader.announceToCatalog` catches, records the age `/health` reports as an
   * unlisted stream, and re-attempts on the announce cadence. `completeFinalize` lets it propagate so
   * the drain records a failure and the recovery entry stays on disk for the next boot.
   */
  public async upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    return this.report(identity, rendition);
  }

  /**
   * Record that this rung ended without a recording, report the rung to the admin as it stands, and say
   * what that achieved. See {@link LadderRegistry.recordRungUnfinished}.
   *
   * Reported rather than judged off a ladder held here, so it also works in a process that holds
   * nothing: a rung whose recovery entry is retried at the next boot and fails again is marked by a
   * process that never saw the rest of its ladder. The report carries no recording, and the admin keeps
   * the recording it holds for a rung that reports on the same topic without one, so it cannot change
   * what the admin says this rung recorded.
   *
   * The mark goes on first and stays even when the report fails, because it is this process's own
   * knowledge: a sibling that finishes afterwards still finds it and finishes the ladder.
   */
  public async recordRungUnfinished(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    this.markUnfinished(identity.group, rendition.name);
    return this.report(identity, rendition);
  }

  private async report(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    const adminStreamId = identity.adminStreamId;
    if (adminStreamId === undefined) {
      // Unreachable from the live path: the engine resolves the declaration before anything starts and
      // the orchestrator refuses an announce without one. Said rather than assumed, because the
      // alternative is a report addressed to `undefined` and a 404 that reads like a deleted stream.
      throw new Error(
        `Ladder ${identity.group} has no admin stream id, so its rung ${rendition.name} has nothing to report to`,
      );
    }

    const report = await this.client.reportRendition(adminStreamId, rendition);
    if (report === null) {
      throw new Error(
        `Could not report rendition ${rendition.name} of ladder ${identity.group} to the admin API, so the ` +
          'ladder it holds is missing this rung and no viewer is offered it',
      );
    }

    const { group } = identity;
    if (hasRecording(rendition)) {
      this.unfinished.get(group)?.delete(rendition.name);
    }
    const announced = this.recordingOf(report, group);
    if (report.streamStatus === ADMIN_STATE_VOD) {
      this.unfinished.delete(group);
    }
    return announced;
  }

  /**
   * Whether this answer is the moment the ladder became a recording, how long the recording plays, and
   * which recording names it.
   *
   * The ladder's recording is its lowest finished rung's, as the stream list entry's own `recording`
   * is, since the admin answers the rungs ascending by height.
   *
   * The admin raises `flippedToFinished` on the report that completed ITS merge, where every rung has a
   * recording, and it cannot see a rung that will not finish. So the flip is read off
   * `LadderCompletion`'s judgement of the ladder in this answer and the status the admin holds:
   * finished and not yet held as `vod` is a flip to report, and held as `vod` is not. That includes the
   * report on which the admin's own merge first finishes because the rung left out finished after all,
   * which adds that rung to the recording and is not a second ending. Judged on this answer's own
   * ladder, the way the admin's flag is.
   */
  private recordingOf(report: RenditionReportResponse, group: string): RenditionAnnouncement {
    const heldAsRecording = report.streamStatus === ADMIN_STATE_VOD;
    const finished = isFinishedLadder(report.renditions, this.markedUnfinished(group));
    // A finished ladder not yet `vod` at the admin is owed a report whether or not this is the announce
    // that finished it, as the class doc says. Null status is a body that did not say, and then only the
    // admin's own flip decides, which cannot see a rung that will not finish.
    const finishedButUnreported = finished && report.streamStatus !== null && !heldAsRecording;
    return {
      flippedToFinished: (report.ladder.flippedToFinished && !heldAsRecording) || finishedButUnreported,
      duration:
        finished && !report.ladder.finished
          ? recordingDuration(recordedRungs(report.renditions))
          : report.ladder.duration,
      recording: finished || report.ladder.finished ? lowestRecording(report.renditions) : null,
    };
  }

  private markedUnfinished(group: string): ReadonlySet<string> {
    return this.unfinished.get(group) ?? NO_RUNGS;
  }

  private markUnfinished(group: string, rung: string): void {
    const marked = this.unfinished.get(group) ?? new Set<string>();
    marked.add(rung);
    this.unfinished.set(group, marked);
  }
}

/** The recording reference of the lowest rung that names one, or null when none does. */
function lowestRecording(renditions: readonly Rendition[]): string | null {
  const named = renditions.find((rendition) => typeof rendition.recording === 'string');
  return named?.recording ?? null;
}
