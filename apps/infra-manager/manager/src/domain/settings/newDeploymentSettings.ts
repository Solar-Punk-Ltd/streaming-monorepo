import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  adminLinkEditProblem,
  adminOriginOf,
  type DeploymentSettingEntry,
  type EngineName,
  editsAdminLink,
  engineForComponents,
  isSecretSettingKey,
  type ManagerAdminLink,
  type NewDeploymentSetting,
  type NewDeploymentSettingsCatalog,
} from '@streaming-infra-manager/common';

import { ProfileConfigError } from '../errors/ProfileConfigError.js';
import { StackSettingsNotReadyError } from '../errors/StackSettingsNotReadyError.js';
import { isLocalTarget, targetAlias } from '../ports/DeployTargets.js';
import { type InitialStackSettings, NO_STACK_SETTINGS } from '../ProfileRepository.js';
import { deployRootProblem, stackRootOf } from '../versions/stackPaths.js';
import type { StackVersionRecord } from '../versions/StackVersionRepository.js';
import { versionSuppliedSecrets } from '../versions/versionSuppliedSecrets.js';

import { adminLinkBeforeOf } from './adminLinkBefore.js';
import { newDeploymentSettingsCatalogOf } from './deploymentSettingsCatalog.js';
import { settingEditProblems } from './settingEditProblems.js';
import { type VersionSettingsFiles, versionSettingsFilesAt, versionValuesOf } from './versionSettingsFiles.js';

/** The deployment a list is worked out for before it exists, as its create body would describe it. */
export interface NewDeploymentShape {
  kind: string;
  components?: readonly string[] | null;
  /** Where it would deploy. Absent is the manager's own host, as it is for a create. */
  host?: string | null;
}

/** What a deployment not created yet is worked out from: its version's build, for the engine it would run. */
interface NewDeploymentSources {
  root: string;
  engine: EngineName;
  files: VersionSettingsFiles;
  /** The secrets the version requires, which the manager generates at the first deploy where the version leaves one empty. */
  required: readonly string[];
}

/** Refused, as a deployment's own list is, for a version with no build to read the keys from. */
function sourcesOf(version: StackVersionRecord, shape: NewDeploymentShape): NewDeploymentSources {
  const problem = deployRootProblem(version);
  if (problem) throw new StackSettingsNotReadyError(version.name, problem);
  const root = stackRootOf(version);
  const engine = engineForComponents(shape.components);
  return {
    root,
    engine,
    files: versionSettingsFilesAt(root, engine),
    required: version.contract?.requiredSecrets ?? [],
  };
}

function catalogOf(
  version: StackVersionRecord,
  shape: NewDeploymentShape,
  sources: NewDeploymentSources,
): NewDeploymentSettingsCatalog {
  const supplied = versionSuppliedSecrets(sources.root, sources.engine, sources.required);
  return newDeploymentSettingsCatalogOf({
    versionId: version.id,
    contract: version.contract,
    buildId: version.buildId ?? null,
    ...sources.files,
    generatedKeys: sources.required.filter((key) => !supplied.has(key)),
    isLocalTarget: isLocalTarget(targetAlias(shape.host ?? null)),
  });
}

/**
 * The settings a deployment of this version would start with, before it
 * exists: the list the wizard edits and a create body's `stack_settings` is
 * checked against.
 */
export function newDeploymentSettingsCatalogFor(
  version: StackVersionRecord,
  shape: NewDeploymentShape,
): NewDeploymentSettingsCatalog {
  return catalogOf(version, shape, sourcesOf(version, shape));
}

function settable(entries: readonly DeploymentSettingEntry[], key: string): boolean {
  return entries.some((entry) => entry.key === key && entry.declared && entry.owner === null);
}

/**
 * The manager's own web2 admin link as the settings of a create that names
 * neither key, for a deployment that runs a stream uploader, so every new
 * uploader deployment starts with it. Its address alone: the deployment's
 * first deploy generates a token of its own for it (`adminLink/ownAdminToken.ts`).
 * Only a link with both an address and a stored token, which is what registers
 * the deployment's stage and so its token with the admin, and only for a
 * version that lets a create set both keys, so the default never leaves an
 * address the uploader would refuse to start with or a create refused over it.
 */
export function managerLinkSettingsFor(
  link: ManagerAdminLink | null,
  version: StackVersionRecord,
  shape: NewDeploymentShape,
): NewDeploymentSetting[] {
  if (!link?.url || !link.tokenStored || deployRootProblem(version)) return [];
  const { entries } = newDeploymentSettingsCatalogFor(version, shape);
  if (!settable(entries, ADMIN_API_URL_KEY) || !settable(entries, ADMIN_API_TOKEN_KEY)) return [];
  return [{ key: ADMIN_API_URL_KEY, value: link.url }];
}

/** Whether a create leaves the web2 admin link to the manager's default: it names neither key. */
export function leavesAdminLinkToManager(settings: readonly NewDeploymentSetting[]): boolean {
  return !editsAdminLink(settings);
}

/**
 * The stack settings a new deployment is created with, held to the rules a
 * save of its settings page is held to, against the list its version gives a
 * deployment of this shape, and split the way the two columns hold them. That
 * includes the web2 admin rule, judged on what the version gives the two keys
 * and what the create sets for them, the token of the deployment's own counted
 * for the manager's link address. Refused whole, each key named and no secret
 * repeated. A create that names none reads nothing, so it is never refused
 * over a version's files. A token the create types is recorded for the origin
 * of the address the deployment starts with.
 *
 * @param ownTokenFor the address the deployment's first deploy generates a
 *   token of its own for, `ownAdminTokenFor`, or null for none.
 */
export function initialStackSettingsFor(
  name: string,
  version: StackVersionRecord,
  shape: NewDeploymentShape,
  settings: readonly NewDeploymentSetting[],
  ownTokenFor: string | null = null,
): InitialStackSettings {
  if (settings.length === 0) return NO_STACK_SETTINGS;
  const sources = sourcesOf(version, shape);
  const { entries } = catalogOf(version, shape, sources);
  const problems = settingEditProblems(settings, entries);
  if (problems.length > 0) throw new ProfileConfigError(name, problems.join(' '));
  const versionValues = versionValuesOf(sources.files);
  const before = adminLinkBeforeOf({
    current: versionValues,
    version: versionValues,
    requiredSecrets: sources.required,
    ownTokenFor,
  });
  const adminProblem = adminLinkEditProblem(settings, before);
  if (adminProblem) throw new ProfileConfigError(name, adminProblem);
  const values = Object.fromEntries(settings.map(({ key, value }) => [key, value]));
  const initial = initialStackSettingsOf(values);
  const url = values[ADMIN_API_URL_KEY] ?? versionValues[ADMIN_API_URL_KEY] ?? '';
  return values[ADMIN_API_TOKEN_KEY] ? { ...initial, adminTokenOrigin: adminOriginOf(url) ?? '' } : initial;
}

/** Values by key, split the way the two columns hold them: a secret apart from the rest. */
export function initialStackSettingsOf(values: Readonly<Record<string, string>>): InitialStackSettings {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretSettingKey(key)) secret[key] = value;
    else plain[key] = value;
  }
  return { plain, secret };
}
