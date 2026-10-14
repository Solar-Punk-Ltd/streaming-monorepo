import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeploymentSettingsCatalog } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import {
  type BatchUploader,
  ownUploaderOf,
  readStageCatalogs,
  stageUploaderOf,
  stagesUsingNode,
} from './batchUploaders';
import { fetchDeploymentSettings } from './settings/deploymentSettingsApi';
import { settingsReadKey, type DeploymentSettingsLoad } from './settings/useDeploymentSettings';

export interface BatchUploadersLoad {
  uploaders: BatchUploader[];
  /** Reads every uploader's settings list again, and resolves once the answers are in place. */
  reread: () => Promise<void>;
}

interface StageCatalog {
  name: string;
  catalog: DeploymentSettingsCatalog;
}

/**
 * The uploaders a Bee node's batches pay for. A rung's are the stages its pool
 * feeds, each read from that stage's own settings list. Any other node's is
 * its own deployment's, from the list the page already holds, so a Use
 * re-reads the one list the Stack settings card shows as well.
 */
export function useBatchUploaders({
  profile,
  rung,
  profiles,
  nodeBatchIds,
  own,
}: {
  profile: Profile;
  rung: string | null;
  profiles: readonly Profile[];
  /** Every batch the node holds, and the one its deployment stores. */
  nodeBatchIds: readonly string[];
  own: DeploymentSettingsLoad;
}): BatchUploadersLoad {
  const stageNames = rung
    ? stagesUsingNode(
        profiles.filter((candidate) => candidate.name !== profile.name),
        rung,
        nodeBatchIds,
      )
    : [];
  const stages = profiles.filter((candidate) => stageNames.includes(candidate.name));
  const stageCatalogs = useStageCatalogs(stages);

  if (!rung) {
    const uploader = own.catalog ? ownUploaderOf(profile.name, own.catalog) : null;
    return { uploaders: uploader ? [uploader] : [], reread: own.reload };
  }
  return {
    uploaders: stageCatalogs.catalogs.flatMap(({ name, catalog }) => stageUploaderOf(name, catalog, rung) ?? []),
    reread: stageCatalogs.reread,
  };
}

/**
 * What moves a stage's settings list. The instance is in it, because a stage
 * removed and created again under its name answers Apply only for its new
 * instance, whatever its status, batch and pool string.
 */
export function stageReadKey(
  stages: readonly Pick<Profile, 'name' | 'instance_id' | 'status' | 'stamp_id' | 'bee_publishers'>[],
): string {
  return JSON.stringify(stages.map((stage) => [stage.name, stage.instance_id, settingsReadKey(stage)]));
}

/**
 * The settings lists of these stages, read again whenever one of them deploys
 * or has its pool string moved. A stage whose list could not be read in time
 * is left out rather than guessed at. Only the newest round's answers are kept.
 */
function useStageCatalogs(stages: readonly Profile[]): { catalogs: StageCatalog[]; reread: () => Promise<void> } {
  const readKey = stageReadKey(stages);
  const [catalogs, setCatalogs] = useState<StageCatalog[]>([]);
  const latest = useRef(0);
  const names = useRef<string[]>([]);
  names.current = stages.map((stage) => stage.name);

  const reread = useCallback(async () => {
    latest.current += 1;
    const round = latest.current;
    const answered = await readStageCatalogs(names.current, fetchDeploymentSettings);
    if (round !== latest.current) return;
    setCatalogs(answered);
  }, []);

  useEffect(() => {
    void reread();
  }, [reread, readKey]);

  return { catalogs, reread };
}
