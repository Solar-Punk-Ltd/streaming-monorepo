/**
 * An edit that a stream which has gone live may no longer accept. Title,
 * description, tags and the thumbnail stay editable — a typo in a title is
 * worth fixing mid-broadcast — but the schedule is a claim about a stream that
 * has already started, and viewers have seen it on the catalogue entry.
 */
export class StreamLockedError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly field: string,
  ) {
    super('The schedule cannot change once the stream has gone live.');
    this.name = 'StreamLockedError';
  }
}
