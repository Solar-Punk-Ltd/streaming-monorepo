/** A request whose body or parameters a contract schema refused, with every reason it gave. */
export class RequestShapeError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'RequestShapeError';
  }
}
