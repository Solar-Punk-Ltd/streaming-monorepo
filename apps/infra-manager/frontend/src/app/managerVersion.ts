import { type VersionInfo, versionInfo } from '@streaming-infra-manager/common';

import { getJson } from '../http';

/**
 * The build this manager runs, as `GET /version` answers it to a signed-in console: the label its deploy named it
 * with and its commit, each null when it is not set or not of its shape. Read once, by the store, for the sidebar.
 */
export async function fetchManagerVersion(): Promise<VersionInfo> {
  const body = await getJson<{ label?: unknown; commit?: unknown } | null>('/version');
  return versionInfo(body?.label, body?.commit);
}
