import { Typography } from '@mui/material';

import { type VersionInfo, versionDisplay } from '@streaming-infra-manager/common';

/**
 * The sidebar's line under "manager · <host>": the build this manager runs, as every console writes one, with the
 * full commit as its title, and "development build" when no version is set. Nothing while the manager has not said,
 * or could not, because no answer is not a development build.
 */
export function ManagerVersionLine({ version }: { version: VersionInfo | null }) {
  if (!version) return null;
  const { text, title } = versionDisplay(version);
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
