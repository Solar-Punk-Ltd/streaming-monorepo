import { Stack } from '@mui/material';
import type { ReactNode } from 'react';

import { ArchiveProvider, useArchive } from './archive/ArchiveProvider';
import { ArchiveWidget } from './archive/ArchiveWidget';
import { ExportProvider } from './export/ExportProvider';
import { ExportWidget } from './export/ExportWidget';

/** The export and the archive on the server, which every page and every signed-in user shares. */
export function JobProviders({ children }: { children: ReactNode }) {
  return (
    <ExportProvider>
      <ArchiveProvider>{children}</ArchiveProvider>
    </ExportProvider>
  );
}

/**
 * The jobs on the server, floating in the top right of every page for every signed-in user: the export and the
 * archive, one under the other. The one that holds the place a job has comes first, so a running archive shows above a
 * kept export file, and a running export above an archive a user paused.
 */
export function JobWidgets() {
  const { current: archive } = useArchive();
  const widgets =
    archive !== null && archive.holdsPlace
      ? [<ArchiveWidget key="archive" />, <ExportWidget key="export" />]
      : [<ExportWidget key="export" />, <ArchiveWidget key="archive" />];
  return (
    <Stack
      spacing={1}
      sx={{
        position: 'fixed',
        top: 72,
        right: 16,
        width: 300,
        maxWidth: 'calc(100vw - 32px)',
        zIndex: (theme) => theme.zIndex.snackbar,
      }}
    >
      {widgets}
    </Stack>
  );
}
