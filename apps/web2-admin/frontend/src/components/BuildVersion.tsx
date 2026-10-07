import { useEffect, useState } from 'react';
import { Typography } from '@mui/material';
import type { VersionInfo } from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { versionText } from '../format';

/**
 * The build the API runs, as one muted line beside the signed-in account, with the full commit as its title. Mounted
 * only while someone is signed in, so it asks once after each sign-in, and never on the sign-in page. Until the API
 * answers it shows nothing, and nothing when the API cannot say, as one from before the route or one that is down
 * cannot. A 401 has already signed out through the fetch wrapper, as for any other request behind the session. A
 * screen narrower than a tablet leaves it out, where it would push the console's name onto a second line.
 */
export function BuildVersion() {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchVersion().then(
      (answer) => {
        if (!cancelled) setVersion(answer);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (version === null) return null;
  return (
    <Typography
      variant="caption"
      noWrap
      title={version.commit ?? undefined}
      sx={{ color: 'text.secondary', mr: 2, minWidth: 0, display: { xs: 'none', sm: 'block' } }}
    >
      {`Version ${versionText(version)}`}
    </Typography>
  );
}
