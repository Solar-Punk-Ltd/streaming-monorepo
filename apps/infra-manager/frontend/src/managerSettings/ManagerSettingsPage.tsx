import { Stack, Typography } from '@mui/material';

import { ManagerAdminLinkCard } from '../adminLink/ManagerAdminLinkCard';
import { useManagerAdminLink } from '../adminLink/useManagerAdminLink';
import { ArchiveBatchesCard } from '../archiveBatches/ArchiveBatchesCard';
import { useArchiveBatches } from '../archiveBatches/useArchiveBatches';
import { CatalogueNodeCard } from '../catalogueNode/CatalogueNodeCard';
import { useCatalogueNode } from '../catalogueNode/useCatalogueNode';

/**
 * Settings of the manager itself rather than of one deployment or version:
 * the web2 admin link every new uploader deployment starts with, the brand's
 * catalogue node the admin writes the catalogue through, and the archive
 * batches on that node the admin copies recordings onto.
 */
export function ManagerSettingsPage() {
  const load = useManagerAdminLink();
  const catalogue = useCatalogueNode({ poll: true });
  const archive = useArchiveBatches();
  return (
    <Stack spacing={2}>
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
        }}
      >
        What this manager gives the deployments it creates, and the node the brand's catalogue is written through. A
        deployment that exists keeps its own settings, on its own page.
      </Typography>
      <ManagerAdminLinkCard load={load} />
      <CatalogueNodeCard load={catalogue} />
      <ArchiveBatchesCard load={archive} />
    </Stack>
  );
}
