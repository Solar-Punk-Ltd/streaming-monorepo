/**
 * A repository a stack version can be fetched from, and where the stack sits
 * in it. A version is a ref of a repository on the allow-list STACK_SOURCES
 * names, and of nothing else: an operator adds a version by its ref alone.
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

/**
 * The repositories a manager builds from when STACK_SOURCES is unset: the
 * monorepo first, where new versions come from, and the stack's earlier
 * repository, which every version recorded before the monorepo names.
 */
export const DEFAULT_STACK_SOURCES: readonly StackSource[] = [MONOREPO_STACK_SOURCE, SWARM_HLS_STREAM_SOURCE];

/** The clone addresses the build script and the stack_versions check constraint accept. */
const CLONE_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;

/** `.` or a relative folder of plain names, the build script's own rule. */
const STACK_FOLDER = /^(\.|[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*)$/;

/**
 * The allow-list STACK_SOURCES names, or the upstream repositories when it is
 * unset. Comma separated, each entry an https GitHub clone address followed by
 * `#<folder>` where the stack sits in that repository, `.` for the whole tree.
 * An entry without a folder is laid out like the monorepo, so a fork of it is
 * named by its address alone. The first entry is where a new version, and the
 * bundled one, is fetched from.
 *
 * A malformed value stops the manager at startup rather than being dropped,
 * because a version added from a repository nobody meant is a deployment of
 * code nobody chose.
 */
export function parseStackSources(raw: string | undefined): StackSource[] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_STACK_SOURCES];
  const sources: StackSource[] = [];
  for (const entry of value.split(',').map((part) => part.trim())) {
    if (entry === '') throw new Error(`STACK_SOURCES has an empty entry: ${raw}`);
    const [url = '', folder = MONOREPO_STACK_SOURCE.folder, ...rest] = entry.split('#');
    if (rest.length > 0 || !CLONE_URL.test(url)) {
      throw new Error(`STACK_SOURCES entries must be https://github.com/<owner>/<repo>.git[#<folder>], got: ${entry}`);
    }
    if (!STACK_FOLDER.test(folder) || folder.includes('..')) {
      throw new Error(`STACK_SOURCES folder must be . or a relative folder of plain names, got: ${entry}`);
    }
    if (sources.some((source) => source.url === url)) {
      throw new Error(`STACK_SOURCES names ${url} twice`);
    }
    sources.push({ url, folder, historyHead: folder === '.' ? null : STACK_IMPORT_HEAD });
  }
  return sources;
}

/** The source a version's recorded repository names, or null for one this manager does not build from. */
export function stackSourceAt(
  url: string,
  sources: readonly StackSource[] = DEFAULT_STACK_SOURCES,
): StackSource | null {
  return sources.find((source) => source.url === url) ?? null;
}
