/**
 * The tool will not cut, and its message says why in a sentence. A refusal writes nothing: every check runs before the
 * first file is written.
 */
export class Refusal extends Error {}
