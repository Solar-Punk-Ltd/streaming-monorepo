/**
 * Which rungs of a ladder are still being produced, so the master playlist stops advertising one
 * that is not.
 *
 * ## Why this exists
 *
 * The master feed names every rendition a viewer may choose. When a rung stops being produced the
 * master goes on naming it, so a viewer joining afterwards is offered a quality with nothing behind
 * it. Observed 2026-08-31: `[MasterFeedWriter] Master ... written with 4 rung(s): 360p, 480p, 720p,
 * 1080p` logged repeatedly *after* `[SRS] Rung unpublished: live/stream_1080p`.
 *
 * The player has its own defence and it works, so this is no longer the whole of the harm: a viewer
 * who picks the dead rung is moved off it within about seven seconds. What is left is those seven
 * seconds, for every viewer who joins during an outage, on a stream that could simply not have
 * offered it.
 *
 * ## ⛔⛔⛔ Ported from the player's rung-drop rule, and now standing on its own properties
 *
 * The player carried a rung-drop rule in `packages/client/src/components/SwarmHlsPlayer/feedState.ts`
 * from 2026-09-01 until 2026-10-07, and it took **eight attempts** to get right. This rule was ported
 * from it rather than written afresh, so as not to make those mistakes again. Since 2026-10-07 the
 * player follows only the rung it plays and fails over to a sibling it watched make progress
 * (`rungHealth.ts`), so it holds no such rule any more and nothing here has a counterpart to keep in
 * step with. Three properties carry the rule, and each one is a fix for a specific live failure:
 *
 * 1. **Events, never a clock.** Four attempts judged a rung by how long it had been quiet and
 *    three of them shipped a fault. A clock runs during intervals in which nothing could have been
 *    produced, so it measures the outage rather than the rung. A count of deliveries cannot: a whole
 *    broadcast stopping freezes every rung's count and leaves the comparison where it was.
 *
 *    ⛔ A delivery is a **live playlist publish that landed**, never a segment upload (2026-10-14). A
 *    segment no playlist names reaches no viewer, and on the dev stage that day rungs whose segments
 *    all landed published no playlist for a whole broadcast and stayed in the master throughout. One
 *    publish can name several segments when publishing falls behind, so a count here is of publishes.
 *    Every rung coalesces the same way, and the lag below is measured from the rung's own last
 *    publish, so a rung that publishes every second segment while its siblings publish every one is
 *    one or two behind at most, never drifting further.
 * 2. **The reference is a middle rung, never the leader.** A maximum lets any single rung condemn
 *    every other one, because it takes one rung running ahead for the whole rest of the ladder to be
 *    "behind" by however far it ran. The upper middle, so that two rungs dying together are both
 *    still judged against the two that live.
 * 3. **The lag is measured from where the ladder was when this rung last delivered**, not between
 *    cumulative totals. Rungs are separate transcodes writing separate feeds at slightly different
 *    speeds, so cumulative counts drift apart without bound for reasons that are nobody's fault.
 *
 *    ⛔ A rung that has never delivered in this process is measured the same way, from where the
 *    ladder stood when the rung first came to this tracker's notice (2026-10-14): the first time a
 *    master offered it, or its first delivery or failure, whichever came first. It used to read a lag
 *    of zero for ever, so a rung failing from its first second in a process, a re-broadcast whose head
 *    read never settles or a transcoder that never starts, stayed in the master for the whole
 *    broadcast. A rung that merely starts late is safe: such a rung is given
 *    {@link RUNG_FIRST_DELIVERY_GRACE_SEGMENTS} publishes of the middle rung rather than
 *    {@link RUNG_DEATH_LAG_SEGMENTS}, at least eight segment lengths.
 *
 * ⚠️ Two limits, and they now point the same way. Inherited: if THREE die at once the middle sits
 * among the dead and none of them reads as dead. Past
 * {@link MAX_RUNGS_DROPPED_AT_ONCE} nothing is dropped anyway. Both say a ladder losing most of
 * itself is a broadcast ending rather than rungs failing, which is not this class's job.
 *
 * ## ⚠️ Taking a rung back
 *
 * Deciding that a rung has STOPPED is the ported rule, all three properties included. Deciding when it
 * may come BACK has been this rule's own since 2026-09-24. The player never takes a rung back: hls.js
 * cannot restore a level it removed, so a rung the player dropped stays dropped for that viewer's
 * session. This rule took a rung back on its first delivery, and a rung whose uploads are being refused
 * still delivers one now and then, which is how the master flipped 793 times on 2026-09-23. So a rung
 * that fell behind while its deliveries were failing is held out until it delivers
 * {@link RUNG_READMIT_AFTER_SEGMENTS} times in a row. A rung that fell behind with nothing failing, such
 * as a transcoder that stopped and came back, still returns on its first delivery.
 *
 * A failure is a segment upload that was refused, which leaves a gap in the playlist, or a live
 * playlist publish that did not land. A viewer who joins later reads this rule's master, and the player
 * could not apply the rule itself: it sees whether a rung's feed advances, never a write being refused.
 */

/**
 * How many deliveries the ladder may make past a rung before the master stops advertising it.
 *
 * Four, the number the player's rung-drop rule used while it had one. A healthy rung is never more
 * than one or two behind the middle, because the rungs of one ladder are cut by one encoder on one
 * keyframe cadence; four is twice the widest healthy gap. A delivery is a live playlist publish, so
 * where publishing coalesces this is four publishes of the middle rung and at least four segments.
 */
export const RUNG_DEATH_LAG_SEGMENTS = 4;

/**
 * How many deliveries in a row a rung whose uploads or playlist publishes were failing must make before
 * the master offers it again.
 *
 * ⛔⛔⛔ Measured live 2026-09-23. 1080p's postage batch was full, so most of its uploads were refused
 * and one landed now and then. The rule took the rung back on each one that landed and dropped it again
 * {@link RUNG_DEATH_LAG_SEGMENTS} of the ladder's segments later, and between 16:17 and 20:14 the
 * master was rewritten 793 times, flipping between three rungs and four about every 18 seconds, and
 * every rewrite was a catalog write too.
 *
 * Twice {@link RUNG_DEATH_LAG_SEGMENTS}, because taking a rung back is the costlier of the two mistakes.
 * A viewer offered a rung that freezes them waits out the player's failover, while a rung kept out a
 * little longer only means one quality is not offered for a few more seconds. So readmission asks for
 * twice the evidence a drop does, and it bounds the flapping as well: a rung that still has one upload
 * in every eight refused never comes back. In time it is at least eight segments of whatever length the
 * deployment cuts, which on the 2 s segments that ladder ran is sixteen seconds of clean uploads.
 */
export const RUNG_READMIT_AFTER_SEGMENTS = 2 * RUNG_DEATH_LAG_SEGMENTS;

/**
 * How many deliveries the ladder may make past a rung that has never delivered before the master stops
 * advertising it.
 *
 * ⛔ Measured on the stage 2026-10-14: at the start of a re-broadcast a rung's first publish waits on
 * a feed head read of 1 to 5 s and a slot probe above it of 0.2 to 4.5 s, so the rungs of one ladder
 * can publish their first playlists more than 3 s apart. At 1 s segments {@link RUNG_DEATH_LAG_SEGMENTS}
 * is four seconds, and a rung starting that late was dropped and taken back at its first publish, two
 * master rewrites for a rung that was only starting. The same number as
 * {@link RUNG_READMIT_AFTER_SEGMENTS}: at least eight segment lengths, so eight seconds at 1 s segments
 * and sixteen at 2 s. A rung that has delivered once is judged by {@link RUNG_DEATH_LAG_SEGMENTS} again.
 */
export const RUNG_FIRST_DELIVERY_GRACE_SEGMENTS = RUNG_READMIT_AFTER_SEGMENTS;

/**
 * How many rungs may be dropped at once before the right conclusion is that the broadcast ended.
 *
 * ⛔⛔⛔ Seen on 2026-09-01, the first sitting with the failover armed. The uploader was
 * killed on a four-rung stage so every rung stopped, and the player concluded three of the four had individually
 * failed and deleted them: hls.js raised a fatal `levelSwitchError` and the whole player destroyed
 * and restarted itself. Rungs do not stop at the same instant, because each drains whatever it was
 * already holding and the queues differ, so a rung that drains further pushes the middle reference
 * up past rungs that stopped with less in hand.
 *
 * One is the whole of the feature: **one quality dies and the others carry on**. A second going
 * quiet is not two independent failures, it is the source going away, and the answer to that is to
 * wait and recover rather than to take the ladder apart.
 *
 * ⚠️ Its honest cost, which is accepted: if two rungs genuinely fail separately during one
 * broadcast, the second dead one is kept and a viewer on it can freeze.
 */
export const MAX_RUNGS_DROPPED_AT_ONCE = 1;

/**
 * The subset of `stopped` that may actually be acted on.
 *
 * ⛔ The limit lives here rather than in {@link LadderLiveness.hasStopped}, because "has this rung
 * stopped" and "may we drop it" are different questions. Two dead rungs really have stopped, and a
 * caller reporting on the ladder should still be told so.
 */
function actionable<T>(stopped: readonly T[]): readonly T[] {
  return stopped.length > MAX_RUNGS_DROPPED_AT_ONCE ? [] : stopped;
}

/** Below this there is no middle rung to measure against, and a viewer has nowhere to go anyway. */
const MIN_RUNGS_TO_COMPARE = 2;

/**
 * Tracks how far each rung of one ladder has got, and answers which of them are still producing.
 *
 * One instance per ladder. Rungs are named by the ladder's own rung names (`1080p`, `720p`), which
 * is what a `Rendition` carries and what the per-rung metrics are labelled with.
 */
export class LadderLiveness {
  private readonly delivered = new Map<string, number>();

  /** Where the ladder's reference stood when this rung last delivered. */
  private readonly referenceAtLastDelivery = new Map<string, number>();

  /**
   * Where the ladder's reference stood when this rung first came to this tracker's notice, for every
   * rung it has heard of, in the order it heard of them. What a rung that has never delivered is
   * measured from.
   */
  private readonly referenceWhenFirstKnown = new Map<string, number>();

  /**
   * Segments landed in a row since this rung last had an upload refused, for every rung that has had
   * one refused and has not yet landed {@link RUNG_READMIT_AFTER_SEGMENTS} since.
   */
  private readonly landedSinceRefusal = new Map<string, number>();

  /** Rungs the ladder left behind while their uploads were being refused, held out until they recover. */
  private readonly heldOut = new Set<string>();

  /**
   * One live playlist publish of this rung landed, so a viewer can be served what it names.
   *
   * The reference is stamped **after** this rung's own count has moved, so a rung that has just
   * delivered reads as level with the ladder rather than one behind it.
   */
  public recordDelivered(rung: string): void {
    this.recordKnown(rung);
    this.delivered.set(rung, (this.delivered.get(rung) ?? 0) + 1);
    this.referenceAtLastDelivery.set(rung, this.reference(this.knownRungs()));
    this.countLandedAfterRefusal(rung);
    this.holdOutRefusedRungsLeftBehind();
  }

  /**
   * One delivery of this rung failed: a segment spent its whole retry window and never reached Swarm,
   * or a live playlist publish did not land.
   *
   * A count of events, like every other input here, and never a clock: it is the other half of
   * {@link recordDelivered}, and together they say whether a viewer is being served this rung.
   */
  public recordUploadFailed(rung: string): void {
    this.recordKnown(rung);
    this.landedSinceRefusal.set(rung, 0);
    this.holdOutRefusedRungsLeftBehind();
  }

  /**
   * A master is about to offer these rungs. One the ladder had not heard of is measured from here
   * until it delivers, which covers a rung nothing in this process ever reports on, such as one whose
   * transcoder never starts while an earlier broadcast left it in the ladder.
   */
  public recordOffered(rungs: readonly string[]): void {
    for (const rung of rungs) {
      this.recordKnown(rung);
    }
  }

  private recordKnown(rung: string): void {
    if (this.referenceWhenFirstKnown.has(rung)) {
      return;
    }
    this.referenceWhenFirstKnown.set(rung, this.reference([...this.knownRungs(), rung]));
  }

  private knownRungs(): string[] {
    return [...this.referenceWhenFirstKnown.keys()];
  }

  private countLandedAfterRefusal(rung: string): void {
    const landed = this.landedSinceRefusal.get(rung);
    if (landed === undefined) {
      return;
    }
    if (landed + 1 < RUNG_READMIT_AFTER_SEGMENTS) {
      this.landedSinceRefusal.set(rung, landed + 1);
      return;
    }
    this.landedSinceRefusal.delete(rung);
    this.heldOut.delete(rung);
  }

  /**
   * Hold out every rung whose deliveries are failing and that the ladder has now left as far behind
   * as {@link dropLagOf} allows, which is the moment the ordinary rule drops it.
   *
   * ⛔ Only once it is that far behind, never on a refusal alone. A rung that has one delivery fail
   * and keeps pace with the ladder never falls behind, and dropping it for that one failure would take
   * a working quality away from every viewer.
   */
  private holdOutRefusedRungsLeftBehind(): void {
    const known = this.knownRungs();
    for (const rung of this.landedSinceRefusal.keys()) {
      if (this.lagOf(rung, known) >= this.dropLagOf(rung)) {
        this.heldOut.add(rung);
      }
    }
  }

  /** How far behind this rung may fall before it is dropped: further while it has never delivered. */
  private dropLagOf(rung: string): number {
    return this.referenceAtLastDelivery.has(rung) ? RUNG_DEATH_LAG_SEGMENTS : RUNG_FIRST_DELIVERY_GRACE_SEGMENTS;
  }

  /**
   * How far the ladder has moved on since this rung last delivered, or, for a rung that never has,
   * since this tracker first heard of it.
   *
   * Zero for a ladder too small to have a middle, and zero for a rung this tracker has never heard of,
   * because there is no moment to measure it from. {@link advertisableRenditions} makes every rung it
   * judges known first, so that is only ever a caller asking about a stranger.
   */
  public lagOf(rung: string, rungs: readonly string[]): number {
    if (rungs.length < MIN_RUNGS_TO_COMPARE) {
      return 0;
    }
    const measuredFrom = this.referenceAtLastDelivery.get(rung) ?? this.referenceWhenFirstKnown.get(rung);
    if (measuredFrom === undefined) {
      return 0;
    }
    return Math.max(0, this.reference(rungs) - measuredFrom);
  }

  /**
   * Whether the ladder has delivered {@link RUNG_DEATH_LAG_SEGMENTS} times while this rung has not
   * ({@link RUNG_FIRST_DELIVERY_GRACE_SEGMENTS} for a rung that never has), or it is held out because
   * its deliveries were failing when that happened and it has not recovered.
   */
  public hasStopped(rung: string, rungs: readonly string[]): boolean {
    return this.lagOf(rung, rungs) >= this.dropLagOf(rung) || this.heldOut.has(rung);
  }

  /**
   * The rungs this ladder knows of that have not stopped, in the order it first heard of them.
   *
   * ⛔ Judged against the rungs this tracker knows about rather than against a caller's list, so it
   * can answer before anyone has handed it a rendition set. That is what lets the publish path ask
   * "has the shape of this ladder changed" on every delivery without reading the catalog feed. A rung
   * a master offered and that has never delivered is among them, so its falling behind changes the
   * shape and the master is rewritten without it.
   */
  public liveRungs(): string[] {
    const known = this.knownRungs();
    const dropped = actionable(known.filter((rung) => this.hasStopped(rung, known)));

    return known.filter((rung) => !dropped.includes(rung));
  }

  /**
   * The upper middle of what the ladder's rungs have delivered.
   *
   * Upper rather than lower so two rungs dying together are both still judged against the two that
   * live. `Math.floor(length / 2)` on an ascending sort is the upper middle for an even count, which
   * is the case a four rung ladder is.
   */
  private reference(rungs: readonly string[]): number {
    const progress = rungs.map((rung) => this.delivered.get(rung) ?? 0).sort((a, b) => a - b);
    return progress[Math.floor(progress.length / 2)] ?? 0;
  }
}

/**
 * Every ladder's liveness by group, and the rungs each one treats as live after a delivery's outcome.
 *
 * One definition for both ladder registries. They differ in where a ladder's merge lives and how a
 * master is rewritten, never in how a rung is judged, and the per-delivery bookkeeping was two
 * identical copies until 2026-09-24, when a second kind of segment outcome would have made it four.
 */
export class LadderLivenessBook {
  private readonly byGroup = new Map<string, LadderLiveness>();

  /** This ladder's liveness, created the first time the ladder is asked about. */
  public of(group: string): LadderLiveness {
    const existing = this.byGroup.get(group);
    if (existing) {
      return existing;
    }
    const created = new LadderLiveness();
    this.byGroup.set(group, created);
    return created;
  }

  /**
   * This ladder's broadcast has ended, so how far its rungs got is history. The next broadcast on the
   * same group, which a declared stream in admin mode is, starts on a fresh tracker and every rung of it
   * gets the grace a rung that has never delivered is given.
   */
  public forget(group: string): void {
    this.byGroup.delete(group);
  }

  /** One live playlist publish of this rung landed. Answers the rungs the ladder now treats as live. */
  public recordDelivered(group: string, rung: string): string[] {
    return this.afterSegment(group, (liveness) => liveness.recordDelivered(rung));
  }

  /** One segment upload or live playlist publish of this rung failed. Answers the live rungs. */
  public recordUploadFailed(group: string, rung: string): string[] {
    return this.afterSegment(group, (liveness) => liveness.recordUploadFailed(rung));
  }

  private afterSegment(group: string, record: (liveness: LadderLiveness) => void): string[] {
    const liveness = this.of(group);
    record(liveness);
    return liveness.liveRungs();
  }
}

/** Named so a caller reads as filtering renditions rather than as knowing about rung names. */
interface NamedRendition {
  readonly name: string;
}

/**
 * The renditions a master should advertise: everything except a rung the ladder has left behind.
 *
 * ⛔ Never returns empty while it was given something. A master naming no renditions is not a
 * degraded ladder, it is an unplayable stream, and the last rung standing is still the only thing a
 * viewer can be offered. The same floor the client draws with `MIN_LEVELS_TO_DROP_ONE`.
 *
 * Every rung offered here becomes known to `liveness`, which is what lets a rung that never delivers
 * be measured at all. See {@link LadderLiveness.recordOffered}.
 */
export function advertisableRenditions<T extends NamedRendition>(
  renditions: readonly T[],
  liveness: LadderLiveness,
): T[] {
  const names = renditions.map((rendition) => rendition.name);
  liveness.recordOffered(names);
  const dropped = actionable(renditions.filter((rendition) => liveness.hasStopped(rendition.name, names)));
  const live = renditions.filter((rendition) => !dropped.includes(rendition));

  return live.length === 0 ? [...renditions] : live;
}
