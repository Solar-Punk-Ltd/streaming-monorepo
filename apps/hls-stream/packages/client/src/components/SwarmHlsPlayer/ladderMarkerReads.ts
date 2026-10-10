import { Topic } from '@ethersphere/bee-js';

import { type LadderMarker, ladderMarkerIdentifier, parseLadderMarker } from '@swarm-hls-stream/shared';

import { type PlayerReader, servedText } from './playerReads';
import { isSlotNotWrittenYet } from './refusedSlot';

/** Marker addresses remembered, far more than one session's start, switches and quiet spells visit. */
const REMEMBERED = 64;

/**
 * Every read of a ladder's time markers one player makes, so that an address is asked once between the
 * start rung's search, a quiet rung's wait and the check that the stream list named every rung.
 *
 * ⛔ **A marker address is asked at most once.** A marker is never rewritten, so one found, missing or
 * malformed stays so, and asking a missing one again would put early asks on one address, which Bee
 * answers by skipping peers for it. A gateway fault is not remembered, since the next ask may well be
 * answered.
 */
export class LadderMarkerReads {
  private readonly answers = new Map<string, Promise<LadderMarker | null>>();

  constructor(private readonly reader: PlayerReader) {}

  /**
   * The marker of `group` for `period`, or null when it is missing or does not parse.
   *
   * @throws What the gateway failed with, when it did not answer.
   */
  read(owner: string, group: Topic, period: number): Promise<LadderMarker | null> {
    const identifier = ladderMarkerIdentifier(group, period).toHex();
    const address = `${owner}/${identifier}`;
    const known = this.answers.get(address);
    if (known !== undefined) {
      return known;
    }

    const answer = this.ask(owner, identifier, period);
    this.answers.set(address, answer);
    answer.catch(() => {
      if (this.answers.get(address) === answer) {
        this.answers.delete(address);
      }
    });
    if (this.answers.size > REMEMBERED) {
      const oldest = this.answers.keys().next().value;
      if (oldest !== undefined) {
        this.answers.delete(oldest);
      }
    }
    return answer;
  }

  private async ask(owner: string, identifier: string, period: number): Promise<LadderMarker | null> {
    let text: string;
    try {
      text = (await servedText(this.reader.readSoc(owner, identifier), `soc/${owner}/${identifier}`)).text;
    } catch (error) {
      if (isSlotNotWrittenYet(error)) {
        return null;
      }
      throw error;
    }
    return parseLadderMarker(text, period);
  }
}
