import { MediaType, Rendition } from '../types.js';

/**
 * Everything about a ladder that is the same for all of its rungs.
 *
 * Declared here rather than beside the catalog that used to be the only thing holding it, because
 * both implementations of {@link LadderRegistry} are handed one and only one of them is a catalog.
 */
export interface LadderIdentity {
  title: string;
  owner: string;
  /**
   * What ties the rungs together: the catalog entry's key, and the name every rung's own topic is
   * derived from. See `rungTopicFor`.
   */
  group: string;
  mediatype: MediaType;
  /**
   * The admin's own id for this broadcast, in admin mode, which every report to it names.
   *
   * A property of the ladder rather than of the rung, in the same way the group is: one declared
   * stream is one ladder, and all four rungs report their records against it. Absent standalone,
   * where nothing is reported to anybody — {@link StreamCatalog} never reads it.
   */
  adminStreamId?: string;
}

/**
 * What one rung's announce achieved for the whole ladder, which is more than that rung can see.
 *
 * ⛔ A rung announcing itself again without a recording is a rung that is LIVE again, on the topic it
 * was already on: its topic is derived from the group and its rung name, so it is the same string it
 * announced last time. Whatever finished record it replaces stays addressable until that rung's next
 * finalize arrives with a recording of its own. See `StreamCatalog.keepingWhatFinished`.
 *
 * ⛔ Returned rather than inferred by the caller, and that is the same rule
 * `StreamCatalog.addStream` already follows for a single-rendition stream: a rung announces its own
 * record and the *ladder* is what flips, so the only thing that can say whether this announce is the
 * moment the broadcast became a recording is whatever holds the other three rungs. A session
 * announcing a flip off its own intent reports one broadcast ending twice, which is what a resumed
 * finalize does.
 */
export interface RenditionAnnouncement {
  /**
   * The reference of the ladder's recording when it is one: its lowest finished rung's recording, which
   * is what the stream list entry's own `recording` names. Null while the ladder is live, and for a
   * finished rung that named its recording only by a feed index.
   */
  recording: string | null;
  /**
   * Whether this announce is the moment the ladder became a recording, and none before it: every rung
   * has finalized or is known not to finish, and at least one finalized. See `LadderCompletion`.
   */
  flippedToFinished: boolean;
  /** Playing time of the finished recording in seconds, when the ladder flipped. */
  duration: number | null;
}

/**
 * Where a rung's rendition record goes.
 *
 * Two implementations, one per deployment, and the split is the whole of ABR in admin mode.
 * {@link StreamCatalog} merges the four rungs into one catalog entry on Swarm. `AdminLadderRegistry`
 * posts each record to the admin, which holds the merge state and writes its own catalog entry. A
 * player builds the ladder's master playlist from the entry's renditions. Neither registry knows about
 * the other, and the uploader knows about neither.
 */
export interface LadderRegistry {
  /** Merge one rung into its ladder, and say what that achieved. */
  upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement>;

  /**
   * This rung's session ended without a recording, so the ladder is not to wait for it: merge the rung
   * as it last announced itself, record that it will not finish, and say what that achieved.
   *
   * ⛔ The record has to survive every later announce of this rung that carries no recording. A rung
   * recovered at the next boot announces itself before it finalizes, and that announce must not turn a
   * finished recording back into a live broadcast. An announce WITH a recording replaces the record,
   * and the ladder's recording then names that rung too.
   *
   * @param rendition the rung as it stands, with no recording to point at.
   */
  recordRungUnfinished(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement>;
}
