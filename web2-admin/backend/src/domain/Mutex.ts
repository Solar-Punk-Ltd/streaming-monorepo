/**
 * A one-slot async mutex: `run` queues the given function behind everything
 * already queued. Used to serialise feed writes — the stream list feed is a
 * single-writer structure and two writers at one index fork it.
 *
 * The tail promise never rejects (rejections are absorbed into the chain, not
 * swallowed from the caller), so one failed critical section does not wedge
 * the queue.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
