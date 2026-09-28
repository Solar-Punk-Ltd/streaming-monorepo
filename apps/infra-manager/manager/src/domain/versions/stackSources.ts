/**
 * A repository a stack version can be fetched from, and where the stack sits
 * in it. Never operator supplied: a version is a ref of the stack this manager
 * deploys, from a repository named here, and nothing else.
 */
export interface StackSource {
  /** The https clone address, fetched without a login. */
  url: string;
  /** `.` when the whole tree is the stack, or the folder that holds it. */
  folder: string;
  /**
   * A commit whose ancestors are the stack's own history, from before it moved
   * into `folder`, or null for a repository it never moved in. A commit of that
   * history has the stack at its root, so it is built whole.
   */
  historyHead: string | null;
}

/** The stack's own repository, whose whole tree is the stack. Every version built before the monorepo came from here. */
export const SWARM_HLS_STREAM_SOURCE: StackSource = {
  url: 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git',
  folder: '.',
  historyHead: null,
};

/**
 * The stack head the monorepo's import took in: swarm-hls-stream's main when
 * the stack moved into apps/hls-stream, brought in with its commit ids, so it
 * and every ancestor of it are commits of the monorepo too.
 */
export const STACK_IMPORT_HEAD = 'b4912eb01dafb934cbb3bd9607c73724c5ec6bfb';

/**
 * The monorepo this manager ships in. Every version added from now on, and the
 * bundled one, comes from here: apps/hls-stream for a commit made since the
 * import, the whole tree for a commit of the stack's own history.
 */
export const MONOREPO_STACK_SOURCE: StackSource = {
  url: 'https://github.com/Solar-Punk-Ltd/streaming-monorepo.git',
  folder: 'apps/hls-stream',
  historyHead: STACK_IMPORT_HEAD,
};

/** The source a version's recorded repository names, or null for one this manager does not build from. */
export function stackSourceAt(url: string): StackSource | null {
  return [MONOREPO_STACK_SOURCE, SWARM_HLS_STREAM_SOURCE].find((source) => source.url === url) ?? null;
}
