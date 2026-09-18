/** A password the policy in web2-admin-common refuses, with the reason why. */
export class WeakPasswordError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'WeakPasswordError';
  }
}
