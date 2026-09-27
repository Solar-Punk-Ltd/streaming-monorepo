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
}

/** The stack's own repository, whose whole tree is the stack. Every version built before the monorepo came from here. */
export const SWARM_HLS_STREAM_SOURCE: StackSource = {
  url: 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git',
  folder: '.',
};
