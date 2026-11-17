/**
 * One holder at a time, in the order they asked, within this process. The manager runs as one process, so a lock
 * held here keeps two of its own requests apart; it keeps nothing apart across processes.
 */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `work` once every holder before it has finished, and answers what it answers or rejects as it rejects. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
