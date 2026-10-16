import { useCallback, useEffect, useRef, useState } from 'react';

import { type DeploymentSettingsCatalog, getErrorMessage } from '@streaming-infra-manager/common';

import { ApiError } from '../../http';
import type { Profile } from '../../types';
import { fetchDeploymentSettings } from './deploymentSettingsApi';
import { type LoadFailure, loadFailureOf } from './settingsText';

const READ_TIMEOUT_MS = 15_000;

const TIMED_OUT = 'The manager did not answer in time. Try again.';

export interface DeploymentSettingsLoad {
  /** The list as last read, kept while the next read is on its way so the page does not blank out. */
  catalog: DeploymentSettingsCatalog | null;
  /** Why the latest read failed, or null. */
  failure: LoadFailure | null;
  /** Reads the list again, and resolves once the answer or the failure is in place, with the answer, or null when it failed or a newer read overtook it. */
  reload: () => Promise<DeploymentSettingsCatalog | null>;
}

/**
 * What moves a deployment's list without a save on its page. Apply and Start
 * both go through a deploy, which moves the status. A batch set with Use, or
 * bought and set on its own, moves `STAMP`, and a batch set on a rung moves
 * the pool string of every stage its pool feeds, while nothing that runs has
 * changed. A list read before any of these is out of date the moment it lands.
 */
export function settingsReadKey(profile: Pick<Profile, 'status' | 'stamp_id' | 'bee_publishers'>): string {
  return JSON.stringify([profile.status, profile.stamp_id ?? null, profile.bee_publishers ?? null]);
}

/**
 * A deployment's settings list, read when the page opens and again whenever
 * its `settingsReadKey` moves. Only the newest read's answer is kept.
 */
export function useDeploymentSettings(profile: Profile): DeploymentSettingsLoad {
  const { name } = profile;
  const readKey = settingsReadKey(profile);
  const [catalog, setCatalog] = useState<DeploymentSettingsCatalog | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const latest = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, READ_TIMEOUT_MS);
    try {
      const answer = await fetchDeploymentSettings(name, controller.signal);
      if (request !== latest.current) return null;
      setCatalog(answer);
      setFailure(null);
      return answer;
    } catch (caught) {
      if (request !== latest.current) return null;
      setFailure(
        caught instanceof ApiError
          ? loadFailureOf(caught.code, caught.message)
          : loadFailureOf(null, timedOut ? TIMED_OUT : getErrorMessage(caught, 'The manager did not say why.')),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, [name]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current += 1;
      inFlight.current?.abort();
    };
  }, [reload, readKey]);

  return { catalog, failure, reload };
}
