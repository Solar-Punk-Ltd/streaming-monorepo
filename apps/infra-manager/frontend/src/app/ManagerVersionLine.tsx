import { Typography } from '@mui/material';

import { type VersionInfo, versionDisplay } from '@streaming-infra-manager/common';

/**
 * The sidebar's line under "Streaming Infra": the name of this manager instance when it has one, then the build it
 * runs, as every console writes one, with the full commit as its title, and "development build" when no version is
 * set. The build is left out while the manager has not said, or could not, because no answer is not a development
 * build, and the line is empty when there is no name either.
 */
export function ManagerVersionLine({
  version,
  instanceName = null,
}: {
  version: VersionInfo | null;
  /** The name this manager instance goes by, or null when it has none. */
  instanceName?: string | null;
}) {
  const build = version ? versionDisplay(version) : null;
  const parts = [instanceName, build?.text].filter((part) => part != null);
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  const title = build?.title ?? null;
  return (
    <Typography
      variant="caption"
      title={title ?? undefined}
      sx={{ display: 'block', color: 'text.secondary', lineHeight: 1.3, overflowWrap: 'anywhere' }}
    >
      {text}
    </Typography>
  );
}
