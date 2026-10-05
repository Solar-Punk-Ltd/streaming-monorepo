import { BroadcastAnchor, BroadcastEpoch } from '../types.js';

const MS_PER_SECOND = 1000;

/**
 * How far a segment's measured length may sit from the configured one and still be dated as that
 * configured length.
 *
 * **What it is: the rounding band of one keyframe grid seen by several encoders.** Under
 * `ABR_ENABLED` every rung is re-encoded from one source with a keyframe forced every
 * `ABR_FPS x HLS_FRAGMENT` frames, and SRS cuts on that keyframe, so all four rungs are cutting the
 * same instants of media. What separates their readings is 90kHz tick rounding at a frame rate that
 * does not divide it, which is a fraction of a percent. One percent covers that with room and
 * nothing else, which is the whole job: every rung reads the same segment as the configured length,
 * so all four date it identically while each publishes its own `#EXTINF`.
 *
 * ⛔ **What it is NOT: `FRAGMENT_TOLERANCE` from `fragmentAgreement.ts`, and the two are different
 * numbers on purpose.** That one answers a different question, whether this stage is misconfigured,
 * and it is five percent because it has to survive a segment SRS force-closed at
 * `HLS_FRAGMENT x HLS_AOF_RATIO` without calling a correct deployment broken. Borrowing it here
 * would leave real media unmeasured: a segment of 2.067 seconds against a configured 2 is inside
 * five percent, so it would be dated as 2.000 and its 67 milliseconds lost, every segment, which is
 * about two minutes an hour. That is the exact live stream this dating exists to fix, measured
 * 2026-09-15.
 *
 * The consequence, both ways. A measured duration within one percent of the configured length is
 * read as the configured length, so the rungs of a ladder stay identical to the millisecond.
 * Anything wider is read as itself, rounded to the millisecond, so a recording says what its media
 * really did.
 */
export const DATING_SNAP_TOLERANCE = 0.01;

/**
 * How far the dating a restart already minted may sit from the wall clock and still be read as that
 * same restart.
 *
 * ⛔ Two failures pull on this number in opposite directions, and they are not equally bad.
 *
 * Too tight, and a rung that crosses the restart later than its siblings mints a line of its own.
 * The ladder then dates one segment two different ways, which hls.js reads as the rungs covering
 * different media, and a level switch lands somewhere else. The 1080p rung is the one this happens
 * to: it is the slowest to transcode and the slowest to upload, and after a restart it has been
 * measured tens of seconds behind the three fast rungs before its first segment lands at all.
 *
 * Too loose, and two restarts close together collapse into one, so the media after the second one is
 * dated from the first one's line and lags by however long the second outage was. That lag is
 * bounded by this number, against the unbounded one it replaces.
 *
 * Two minutes therefore, because a bounded lag is the cheaper of the two failures.
 */
export const SAME_RESTART_TOLERANCE_MS = 120_000;

/** The sequence a playlist starts its numbering at, which an epoch only names when a new session renumbers. */
const RENUMBERED_FROM = 0;

/** Where a broadcast's dating starts, which is the epoch every sequence below the first restart takes. */
function openingEpoch(anchor: BroadcastAnchor): BroadcastEpoch {
  return { fromSequence: 0, atMs: anchor.startedAtMs };
}

/**
 * The epoch a playlist sequence is dated from: the newest one that starts at or below it.
 *
 * The list is kept in `fromSequence` order by {@link withEpoch}, so the first match walking back is
 * the newest, and a sequence below every epoch falls through to the broadcast's own start.
 */
function epochFor(anchor: BroadcastAnchor, sequence: number): BroadcastEpoch {
  const epochs = anchor.epochs ?? [];
  for (let i = epochs.length - 1; i >= 0; i--) {
    if (epochs[i].fromSequence <= sequence) {
      return epochs[i];
    }
  }
  return openingEpoch(anchor);
}

/** The date `sequence` carries under `epoch`, stepping by the declared fragment length. */
function dateOnLine(epoch: BroadcastEpoch, sequence: number, fragmentSeconds: number): number {
  return epoch.atMs + Math.round((sequence - epoch.fromSequence) * fragmentSeconds * MS_PER_SECOND);
}

/**
 * When the segment at this playlist sequence is presented, counting every sequence below it as one
 * configured fragment of media.
 *
 * What the dating was before it followed the media, and still the answer in the two places where no
 * media is there to follow: the first segment placed at or after an epoch, and a sequence nothing
 * has been placed below. {@link presentationMsOf} dates a segment that has media in front of it.
 */
export function programDateTimeMsOf(anchor: BroadcastAnchor, sequence: number): number {
  return dateOnLine(epochFor(anchor, sequence), sequence, anchor.fragmentSeconds);
}

/**
 * The media one segment contributes to the date of the one after it, in milliseconds.
 *
 * ⛔ **A measurement inside {@link DATING_SNAP_TOLERANCE} of the configured length is read AS the
 * configured length, and that is what keeps a ladder's rungs agreeing to the millisecond.** Every
 * rung of one ladder is cut on one keyframe grid, so what separates their readings of a segment is
 * tick rounding rather than media, and reading all of those as the configured length makes four
 * rungs date one piece of media identically while each keeps its own `#EXTINF`.
 *
 * Outside that band the segment is read as itself. That is the single-rendition stage, where the
 * publisher's own keyframe interval decides the segment and `HLS_FRAGMENT` is a floor: segments
 * measured 2.067 to 10.033 seconds against a configured 2 on 2026-09-15, and dating each of them at
 * 2.000 put the recording's wall clock further behind its own media with every segment, permanently.
 */
export function datedDurationMs(measuredSeconds: number, fragmentSeconds: number): number {
  const onTheGrid = Math.abs(measuredSeconds - fragmentSeconds) <= fragmentSeconds * DATING_SNAP_TOLERANCE;
  return Math.round((onTheGrid ? fragmentSeconds : measuredSeconds) * MS_PER_SECOND);
}

/** A segment already placed in the broadcast, as the dating reads one. */
export interface PlacedMedia {
  sequence: number;
  /** When it is presented, as {@link presentationMsOf} decided when it was placed. */
  presentedAtMs: number;
  /** Its own measured `#EXTINF`, in seconds. */
  durationSeconds: number;
}

/**
 * When the segment at `sequence` is presented, given the newest segment placed below it.
 *
 * ⛔ **Decided from the shared anchor plus the media in front of it, never from an arrival time.**
 * Four rung uploaders stamping the clock they received a segment at would disagree about the same
 * media by their upload jitter, and hls.js reads that as the rungs covering different media.
 *
 * A sequence between the two carries no media anybody observed, so it is charged the configured
 * length. That is also the `#EXTINF` its own `#EXT-X-GAP` entry declares, so a hole says the same
 * length it occupies.
 *
 * `previous` is null where nothing has been placed below `sequence`, and a `previous` that sits
 * below the epoch dating `sequence` is media from before a restart. Both take the epoch's own
 * arithmetic, which is what re-anchoring on the wall clock means.
 */
export function presentationMsOf(anchor: BroadcastAnchor, sequence: number, previous: PlacedMedia | null): number {
  const epoch = epochFor(anchor, sequence);
  if (previous === null || previous.sequence < epoch.fromSequence) {
    return dateOnLine(epoch, sequence, anchor.fragmentSeconds);
  }

  const lost = sequence - previous.sequence - 1;
  return (
    previous.presentedAtMs +
    datedDurationMs(previous.durationSeconds, anchor.fragmentSeconds) +
    Math.round(lost * anchor.fragmentSeconds * MS_PER_SECOND)
  );
}

/**
 * The dating with `epoch` in it, returned as a new anchor so a session still holding the old one
 * keeps the dates it published.
 *
 * ⛔ **An epoch at the same sequence is replaced; one at a different sequence is KEPT, whichever side
 * of the new one it falls.** The list is the whole ladder's, so a rung joining from a sequence below
 * its siblings' is writing down its own point on their line, not superseding it — and dropping
 * everything above it left a third rung asking at the original sequence with nothing to join, so it
 * minted a line of its own and the ladder dated one instant two ways. Sorted by `fromSequence` and
 * complete, which is what makes {@link epochFor} unambiguous: it walks back to the newest epoch at or
 * below the sequence it is dating, so nothing dated before the join can move.
 *
 * ⛔⛔ **Except an epoch at sequence 0, which starts a new numbering and supersedes the whole list.**
 * Only a replacement session writes one (`reanchorReplacedBroadcast`): it publishes a fresh playlist
 * numbered from zero again, and every other re-anchoring resumes at the sequence after one already
 * placed, so it is never 0. Kept, the old session's epochs are NOT out of reach: {@link epochFor}
 * returns the highest epoch at or below the sequence rather than the newest added, so once the
 * replacement numbers up to an epoch its predecessor minted at 10, sequence 10 dates from that
 * line, which is behind the replacement's own, and `#EXT-X-PROGRAM-DATE-TIME` goes backwards
 * mid-playlist. hls.js reads that as a parsing error and a recording is sealed with it. A counter
 * restart inside the replacement would also take the stale epoch as its newest line.
 *
 * ⭐ Clearing the shared record re-dates nothing already published. Each session dates from its own
 * copy of the anchor, so a ladder rung still finishing its old session keeps the epochs it held.
 */
export function withEpoch(anchor: BroadcastAnchor, epoch: BroadcastEpoch): BroadcastAnchor {
  if (epoch.fromSequence === RENUMBERED_FROM) {
    return { ...anchor, epochs: [epoch] };
  }
  const kept = (anchor.epochs ?? []).filter((held) => held.fromSequence !== epoch.fromSequence);
  return { ...anchor, epochs: [...kept, epoch].sort((a, b) => a.fromSequence - b.fromSequence) };
}

interface ReanchorRequest {
  /** The first playlist sequence the resuming rung will publish, which is its own re-anchoring point. */
  resumeAt: number;
  /** The wall clock now, which is what a re-anchoring exists to put on the media. */
  nowMs: number;
  /**
   * The earliest date `resumeAt` may carry, which its caller takes as the date that sequence would
   * have carried had nothing restarted.
   */
  notBeforeMs: number;
  /**
   * Which return of the broadcast is asking, for a rung whose encoder came back. Absent where the
   * engine's own counter restarted, which nothing outside this rung witnesses.
   *
   * ⛔ This is the whole of how siblings are recognised. See {@link BroadcastEpoch.returnToken}.
   */
  returnToken?: string;
  /**
   * The sequence `resumeAt` is published as, for a rung whose encoder came back. What a rung joining
   * its return's line is placed on the line by. See {@link BroadcastEpoch.publishedFrom}.
   */
  publishedResumeAt?: number;
}

/**
 * Where a rung asks for the dating of a restart, so every rung of one ladder gets the same answer.
 *
 * Implemented by the orchestrator against the anchor a broadcast's rungs share, and defaulted inside
 * {@link ManifestManager} for a manager built without one.
 */
export interface BroadcastDating {
  /**
   * The epoch a rung whose numbering resumes at `resumeAt` dates from, always starting at exactly
   * that sequence so nothing the rung has already published is re-dated.
   *
   * @param returnToken which return of the broadcast is asking, for a rung whose encoder came back.
   * Omitted where the engine's own counter restarted. See {@link BroadcastEpoch.returnToken}.
   * @param publishedResumeAt the sequence `resumeAt` is published as, given with `returnToken`.
   */
  epochFrom(resumeAt: number, notBeforeMs: number, returnToken?: string, publishedResumeAt?: number): BroadcastEpoch;

  /**
   * The published sequence a rung coming back from this return resumes at, which is the same answer
   * for every rung of the return and never below `ownResumeAt`, the published sequence one past the
   * highest the asking rung has placed. See {@link sharedResumePoint}.
   */
  resumePointFor(returnToken: string, ownResumeAt: number): number;
}

/**
 * How many sequences a return may raise a rung above its own count. Above it the rung resumes at its
 * own count instead.
 *
 * ⛔ **A bound on how wrong the agreement can be, not a measurement.** The rungs of one ladder are cut
 * on one keyframe grid, so what separates their counts at an outage is a short partial segment one of
 * them closed and the segments the engine had not yet handed over, a sequence or two on a test
 * deployment, with the breaks four apart in the worst case measured. A point further above a rung
 * than that names media the rung never
 * had, and every sequence of the raise is a gap entry spent from the live window's byte budget, so a
 * runaway point would push media out of the window. Five covers the measured four with one to spare.
 */
export const MAX_RESUME_RAISE = 5;

/** The rung resumed at the point its return agreed. */
export const RESUMED_AT_THE_RETURN = 'at-the-return' as const;
/** The rung had already counted past the point its return agreed, and resumed at its own count. */
export const RESUMED_ABOVE_THE_RETURN = 'above-the-return' as const;
/** The point its return agreed was more than {@link MAX_RESUME_RAISE} above it, so it resumed at its own count. */
export const RAISE_REFUSED = 'raise-refused' as const;

/** Where one rung of a return resumes, and how that relates to the point the return agreed. */
export interface ResumeDecision {
  resumeAt: number;
  kind: typeof RESUMED_AT_THE_RETURN | typeof RESUMED_ABOVE_THE_RETURN | typeof RAISE_REFUSED;
}

/**
 * The point every rung of one return resumes at, agreed once by the first rung of it to place a
 * resumed segment: the furthest any rung of the ladder has counted, in published numbers.
 *
 * ⛔⛔ **One sequence names one moment on every rung, so a return resumes them all at one sequence.**
 * The rungs stop at different counts before an outage. One closes a short partial segment the others
 * do not, or one is a segment behind on its upload, and a player switching quality picks the segment
 * by its sequence. Each rung resuming at its own count put sequence 331 about 30 seconds apart on two
 * rungs of one broadcast measured on a test deployment, with the breaks four sequences apart.
 *
 * ⛔ **Published numbers, never a rung's own.** A rung whose session was replaced numbers its media
 * from 0 again and publishes it above the feed head it took over, so its own count and its siblings'
 * are in two different numberings. Compared raw, a replaced rung twelve segments into its new session
 * either raised its siblings twelve sequences or was raised twelve itself.
 *
 * @param ownResumeAt the published sequence one past the highest the asking rung has placed.
 * @param ladderCounts the published sequence each other live rung of the ladder would resume at.
 */
export function agreedResumePoint(ownResumeAt: number, ladderCounts: readonly number[]): number {
  return Math.max(ownResumeAt, ...ladderCounts);
}

/**
 * Where one rung of a return resumes, given the point its return agreed.
 *
 * ⚠️ **Never below the rung's own count**, because a number already published cannot be reused. A rung
 * still placing segments from before the outage when its siblings agreed the point can pass it, and
 * it then resumes at its own count, a sequence or more above them. **Never more than
 * {@link MAX_RESUME_RAISE} above it either**, because a point that far away is not a rung lining up
 * with its siblings but a count read wrongly, and it would list that many gap entries for media
 * nobody lost.
 *
 * A rung below the point lists the sequences in between as gap entries, which is what a sequence
 * nothing fills already publishes as. See `ManifestManager.placeResumed`.
 */
export function sharedResumePoint(agreed: number, ownResumeAt: number): ResumeDecision {
  if (ownResumeAt > agreed) {
    return { resumeAt: ownResumeAt, kind: RESUMED_ABOVE_THE_RETURN };
  }
  if (agreed - ownResumeAt > MAX_RESUME_RAISE) {
    return { resumeAt: ownResumeAt, kind: RAISE_REFUSED };
  }
  return { resumeAt: agreed, kind: RESUMED_AT_THE_RETURN };
}

/** Which of the two ways a re-anchoring reached its epoch, alongside the epoch itself. */
interface ReanchorDecision {
  epoch: BroadcastEpoch;
  /**
   * Whether the epoch is this rung's own point on a line a sibling already minted for the same
   * restart, rather than a line this rung minted itself.
   *
   * ⭐ Not derivable from the epoch afterwards. A joining rung lands on the date its own sequence
   * already carried far more often than not, so a caller comparing the dating before against the
   * dating after cannot tell a join from a restart that happened to move nothing.
   */
  joined: boolean;
}

/**
 * The epoch a rung takes when its numbering resumes after a restart, reusing the line a sibling
 * already minted for that same restart, and which of those two things it did.
 *
 * ⭐ **What is shared across the ladder is the line, and each rung writes it down at the `resumeAt` it
 * asks about.** After an encoder returns, every rung of the return asks at the same sequence, the one
 * {@link sharedResumePoint} fixes, so they all land on one point of the line. After the engine's own
 * counter restarts, which nothing outside the rung witnesses, each rung still resumes at its own
 * count, and a rung one sequence behind its siblings lands one fragment earlier on that line, which is
 * the same function of sequence they are all reading. Handing it the sibling's point unchanged would
 * leave its own first post-restart segment on the old line, with the whole jump landing on the segment
 * after it, where no discontinuity marks it.
 *
 * ⛔⛔ **A returning encoder's line is recognised by the RETURN it belongs to, and by nothing else.**
 * The orchestrator sees a whole-encoder return once per rung and is the only layer that can tell four
 * webhooks are one event, so it names the return and every rung of that return asks with the same
 * name. Two sequence-shaped rules were tried here first and both were wrong, for reasons worth
 * keeping:
 *
 * - **The clock alone** asked whether the minted line still dates `resumeAt` within
 *   {@link SAME_RESTART_TOLERANCE_MS} of now, which is true of a second outage on the SAME rung for
 *   as long as that outage is shorter than the tolerance: nothing advances while an encoder is away,
 *   so the line reaches the resuming sequence almost exactly where it was written down. Measured on
 *   four fifty second outages: the second return landed 48 seconds behind, the third 96.
 * - **At-or-below the minted sequence** fixed that for a lone rung and failed on a ladder, because
 *   the epoch list is the whole ladder's: the newest epoch is often a SIBLING's, so a rung a segment
 *   behind asked at a sequence below its sibling's line and joined the PREVIOUS return's, again dating
 *   its media a whole outage ago. Reproduced on two rungs one segment apart over two outages, about
 *   half the time depending on which rung came back first. The rungs of one return now ask at one
 *   sequence, but a rung's own next return still asks higher, so the name stays the only test.
 *
 * A name cannot be confused either way: it is minted per return by the layer that witnesses the
 * return, and it is a uuid rather than a count, so it cannot collide with a line the anchor carried
 * across a process restart.
 *
 * ⚠️ **The clock test still governs the other cause**, the engine's own counter restarting, which
 * reaches here with no token because nothing outside the rung witnesses it. That is the shape it
 * still covers and the only one.
 *
 * ⛔ **The broadcast's own start is never reused.** It is where the dating began rather than a
 * re-anchoring, so the first restart of a broadcast always re-anchors, which is the lag this whole
 * shape exists to remove.
 *
 * ⛔ **The floor applies to both branches, because a line is grid arithmetic and the media is not.**
 * A minted epoch takes the wall clock, and a reused one is {@link dateOnLine}, which steps by the
 * configured fragment length from where the line was written down. Neither knows what the asking
 * rung's media actually did. Since the dating started following the media, a rung whose segments run
 * longer than `HLS_FRAGMENT` has stamped its playlist past that arithmetic, by the overrun times the
 * segments since, so the line can name an instant behind the segment already in front of the one
 * resuming. `notBeforeMs` is the caller's own account of the date that sequence would have carried,
 * read off its media rather than off the grid, which is why it is the floor for either answer.
 *
 * What a floorless join cost, on the stage measured 2026-09-15 (`HLS_FRAGMENT=2`, segments really
 * 2.067 seconds): about 67 milliseconds of backwards movement per segment since the restart the line
 * belongs to, up to the tolerance below. A date that goes backwards is not a late date. hls.js reads
 * it as a parsing error rather than as a restart, and a recording is sealed with it for ever.
 */
export function reanchorDecision(anchor: BroadcastAnchor, request: ReanchorRequest): ReanchorDecision {
  const { resumeAt, nowMs, notBeforeMs, returnToken, publishedResumeAt } = request;
  const held = anchor.epochs ?? [];
  const minted =
    returnToken === undefined
      ? // The engine's counter restarted, which only this rung witnessed. The newest line is the only
        // candidate and the clock decides, exactly as it always has.
        held.at(-1)
      : held.find((epoch) => epoch.returnToken === returnToken);

  if (minted !== undefined) {
    const onTheSameLine =
      minted.publishedFrom !== undefined && publishedResumeAt !== undefined
        ? dateOnLine(
            { fromSequence: minted.publishedFrom, atMs: minted.atMs },
            publishedResumeAt,
            anchor.fragmentSeconds,
          )
        : dateOnLine(minted, resumeAt, anchor.fragmentSeconds);
    const sameRestart = returnToken !== undefined || Math.abs(onTheSameLine - nowMs) <= SAME_RESTART_TOLERANCE_MS;
    if (sameRestart) {
      return {
        epoch: {
          fromSequence: resumeAt,
          atMs: Math.max(onTheSameLine, notBeforeMs),
          ...tokenOf(returnToken, publishedResumeAt),
        },
        joined: true,
      };
    }
  }

  return {
    epoch: {
      fromSequence: resumeAt,
      atMs: Math.max(nowMs, notBeforeMs),
      ...tokenOf(returnToken, publishedResumeAt),
    },
    joined: false,
  };
}

/** Kept off the epoch entirely when there is none, so a counter restart's line is byte-identical to before. */
function tokenOf(
  returnToken: string | undefined,
  publishedFrom: number | undefined,
): { returnToken?: string; publishedFrom?: number } {
  if (returnToken === undefined) {
    return {};
  }
  return publishedFrom === undefined ? { returnToken } : { returnToken, publishedFrom };
}

/** {@link reanchorDecision} for a caller with no use for how the epoch was reached. */
export function reanchorEpoch(anchor: BroadcastAnchor, request: ReanchorRequest): BroadcastEpoch {
  return reanchorDecision(anchor, request).epoch;
}

/**
 * The dating of a broadcast with nobody to agree with, which is what a {@link ManifestManager} built
 * without one gets: every restart re-anchors on this process's own wall clock.
 *
 * Production always injects the orchestrator's instead, ladder or not, because a lone rendition is a
 * ladder of one and its dating is kept per broadcast for the same reasons.
 */
export function soleRungDating(anchorOf: () => BroadcastAnchor, wallClock: () => number = Date.now): BroadcastDating {
  return {
    epochFrom: (resumeAt, notBeforeMs, returnToken, publishedResumeAt) =>
      reanchorEpoch(anchorOf(), { resumeAt, nowMs: wallClock(), notBeforeMs, returnToken, publishedResumeAt }),
    // A rung with no siblings has nobody to agree a sequence with.
    resumePointFor: (_returnToken, ownResumeAt) => ownResumeAt,
  };
}
