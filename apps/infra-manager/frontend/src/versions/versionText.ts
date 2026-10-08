import {
  BUNDLED_VERSION_NAME,
  buildLabelText,
  type BuildLabelText,
  type DeploymentShape,
  type ObservedContainer,
  runningCommitOf,
  runningLabelOf,
  type StackVersion,
} from '@streaming-infra-manager/common';

import { formatDateTime, shortCommit } from '../format';

const COMMIT_UNKNOWN = 'commit unknown on this host';
const NOT_OBSERVED = 'not observed yet';

/** Only a recorded invalidation can say that an update removed approval. */
export function lostApprovalWarning(version: StackVersion): string | null {
  return !version.tested && version.testedInvalidatedAt
    ? `Not tested since the update on ${formatDateTime(version.testedInvalidatedAt)}.`
    : null;
}

export function approvalStatusText(version: StackVersion): string {
  return (
    lostApprovalWarning(version) ??
    (version.tested ? 'Tested on this host.' : 'Not currently marked as tested on this host.')
  );
}

/**
 * `bundled @ ee99c36`, or `bundled, commit unknown on this host`.
 *
 * A commit is unknown when the checkout arrived without a .git and without the
 * file deploy.sh writes next to it, which is a real state and not an error.
 */
export function describeVersion(version: StackVersion): string {
  return version.commitSha
    ? `${version.name} @ ${shortCommit(version.commitSha)}`
    : `${version.name}, ${COMMIT_UNKNOWN}`;
}

/**
 * Where the version's stack comes from: `streaming-monorepo, apps/hls-stream`
 * for a build taken from a folder, and the repository alone when its whole tree
 * is the stack or no build has said yet.
 */
export function describeSource(version: StackVersion): string {
  const repository = repositoryName(version.source.url);
  const { folder } = version.source;
  return folder && folder !== '.' ? `${repository}, ${folder}` : repository;
}

/** `streaming-monorepo` out of its clone address. */
function repositoryName(url: string): string {
  return (
    url
      .replace(/\.git$/, '')
      .split('/')
      .at(-1) ?? url
  );
}

/**
 * What pressing Update on this card does, for the one version where the button
 * needs saying. Empty for a version an operator added, whose branch or tag is
 * already on the card and whose Update follows it.
 */
export function updateHint(version: StackVersion): string {
  if (version.name !== BUNDLED_VERSION_NAME) return '';
  const ships = 'Rebuild the version the manager ships with';
  return version.commitSha
    ? `${ships}, commit ${shortCommit(version.commitSha)}.`
    : `${ships}. This host cannot tell which commit that is yet.`;
}

/**
 * Where the version deploys from: `build ee99c36` for a builds row, with
 * `-r2` and the like kept, `flat root` for a legacy one, and for a bundled
 * row never published, the tree that came with the manager.
 */
export function describeBuild(version: StackVersion): string {
  if (version.layout === 'builds') {
    return version.buildId ? `build ${shortBuildId(version.buildId)}` : 'no build yet';
  }
  return version.name === BUNDLED_VERSION_NAME ? 'with the manager, legacy tree' : 'flat root';
}

/** The build the current one replaced, or an empty string. */
export function describePreviousBuild(version: StackVersion): string {
  return version.previousBuildId ? `previous ${shortBuildId(version.previousBuildId)}` : '';
}

/** A build id shortened the way a commit is, with the rebuild suffix kept. */
export function shortBuildId(buildId: string): string {
  const [commit, suffix] = buildId.split(/(?=-r\d+$)/);
  return `${shortCommit(commit ?? buildId)}${suffix ?? ''}`;
}

/**
 * What the deployment's containers were seen to run: one commit, or each
 * service's own when they differ, or that nothing has been observed yet.
 */
export function describeRunning(containers: readonly ObservedContainer[]): string {
  const running = runningCommitOf(containers);
  if (running.kind === 'one') return `commit ${shortCommit(running.commit)}`;
  if (running.kind === 'unknown') return NOT_OBSERVED;
  return `mixed: ${running.byService
    .map(({ service, commit }) => `${service} ${commit ? shortCommit(commit) : NOT_OBSERVED}`)
    .join(', ')}`;
}

/**
 * The Release a version card shows: the release its current build was made
 * as, `QA-build-2026-10-07 (635b4e175)` with the whole commit for a title, or
 * null for a build made with none, which shows nothing.
 */
export function describeRelease(version: StackVersion): BuildLabelText | null {
  return version.buildLabel ? buildLabelText(version.buildLabel, version.commitSha) : null;
}

/**
 * The release a deployment's containers were seen to run, by the same rule, or
 * null when nothing was observed, their build carries none, or they disagree.
 * It can be older than the release the version's card shows: an update moves
 * the version, and only a deploy moves the containers.
 */
export function describeRunningRelease(containers: readonly ObservedContainer[]): BuildLabelText | null {
  const running = runningLabelOf(containers);
  return running ? buildLabelText(running.label, running.commit) : null;
}

/**
 * What a deployment's page calls that release. On a deployment that serves the
 * web player, which is what Watch a stream makes, the release is the player its
 * viewers load, so there it reads as the player's version.
 */
export function runningReleaseKey(shape: DeploymentShape): string {
  return shape === 'viewer' ? 'Player' : 'Release';
}

/**
 * Why no deployment can be created from this version, or null.
 *
 * The contract decides it, so the card and the wizard's version picker say the
 * same sentence and neither has to know what makes a version unusable. Before
 * this the operator learned it only by filling in the whole wizard and pressing
 * Deploy, and the answer then came from the slot allocator, which knows nothing
 * beyond having found no slot.
 */
export function versionPlacementProblem(version: StackVersion): string | null {
  return version.contract?.allocationProblem ?? null;
}
