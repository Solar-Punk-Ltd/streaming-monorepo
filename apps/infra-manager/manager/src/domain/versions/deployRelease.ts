import { getErrorMessage, type StackContract, VERSION_COMMIT_RE } from '@streaming-infra-manager/common';

import { Logger } from '../Logger.js';

import { type BuildManifest, readBuildManifest } from './buildManifest.js';

const logger = Logger.getInstance();

/**
 * The release a deploy names to the stack, which the player builds in and
 * shows in its QoE overlay. docs/features/stack-versions.md, "The player's
 * release".
 *
 * The release is the build's own, off its manifest: the label it was made as,
 * `buildLabel.ts`, and its commit. It is the build the deploy was admitted on,
 * the same manifest the observation after the deploy reads the label of each
 * container off, so the player names the release the At a glance card names.
 */

/** The deploy script's flags for the release, each a case arm of `parse_profile_args` in a version that takes them. */
const RELEASE_LABEL_FLAG = '--release-label';
const RELEASE_COMMIT_FLAG = '--release-commit';
export const RELEASE_FLAGS: readonly string[] = [RELEASE_LABEL_FLAG, RELEASE_COMMIT_FLAG];

/** A release as the deploy script takes it. */
export interface DeployRelease {
  label: string;
  /** The whole commit, or null when the manifest names a shorter one, which the script would refuse. */
  commit: string | null;
}

/**
 * The release of the build at `root`, or null for a root that is not a
 * complete build, such as a legacy flat tree or the bundled checkout, and for
 * a build made with no label. The manifest reader has already left out a label
 * in any other shape than one. A release only names the build, so a manifest
 * that cannot be read leaves the deploy without one rather than failing it,
 * and says why in the log: the reader answers every ordinary problem itself,
 * so what reaches the catch is a build removed while it was read.
 */
export function releaseOfBuild(root: string): DeployRelease | null {
  let manifest: BuildManifest | null;
  try {
    manifest = readBuildManifest(root).manifest;
  } catch (err) {
    logger.warn(
      `[Versions] the release of the build at ${root} could not be read: ${getErrorMessage(err)}. The deploy goes ahead without one.`,
    );
    return null;
  }
  if (!manifest?.label) return null;
  return { label: manifest.label, commit: VERSION_COMMIT_RE.test(manifest.commit) ? manifest.commit : null };
}

/**
 * The deploy script arguments that name the release: none for a version whose
 * contract does not say its script takes them, which reads an unknown flag as
 * a service name and refuses the whole deploy, and none without a release, so
 * the player shows no release rather than a wrong one.
 */
export function releaseArgsFor(contract: StackContract | null | undefined, release: DeployRelease | null): string[] {
  if (contract?.features?.playerRelease !== true || release === null) return [];
  return [
    `${RELEASE_LABEL_FLAG}=${release.label}`,
    ...(release.commit === null ? [] : [`${RELEASE_COMMIT_FLAG}=${release.commit}`]),
  ];
}
