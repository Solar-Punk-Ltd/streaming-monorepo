import { Stack, Typography } from '@mui/material';

import { ManagerAdminLinkCard } from '../adminLink/ManagerAdminLinkCard';
import { useManagerAdminLink } from '../adminLink/useManagerAdminLink';
import { CatalogueNodeCard } from '../catalogueNode/CatalogueNodeCard';
import { useCatalogueNode } from '../catalogueNode/useCatalogueNode';

/**
 * Settings of the manager itself rather than of one deployment or version:
 * the web2 admin link every new uploader deployment starts with, and the
 * brand's catalogue node the admin writes the catalogue through.
 */
export function ManagerSettingsPage() {
  const load = useManagerAdminLink();
  const catalogue = useCatalogueNode({ poll: true });
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
    </Stack>
  );
}
