/** A password the rules refuse, with the reason why. */
export class WeakPasswordError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'WeakPasswordError';
  }
}
