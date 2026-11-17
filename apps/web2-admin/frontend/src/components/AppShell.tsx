import { useState, type MouseEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import { AppBar, Box, Button, Container, Divider, Menu, MenuItem, Toolbar, Typography } from '@mui/material';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import type { ReactNode } from 'react';

import { useAuth } from '../auth';
import { useThemeMenuItems } from '../theme/themeMenuItems';
import { ArchivePanel } from './archive/ArchivePanel';
import { BuildVersion } from './BuildVersion';
import { ExportPanel } from './export/ExportPanel';
import { JobIndicators, JobProviders } from './Jobs';
import { useSnackbar } from './Snackbar';

export const APP_NAME = 'Stream Admin';

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logOut } = useAuth();
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const themeItems = useThemeMenuItems();

  const open = (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget);
  const close = () => setAnchor(null);

  const go = (path: string) => {
    close();
    navigate(path);
  };

  const handleLogOut = async () => {
    close();
    try {
      await logOut();
      navigate('/login');
    } catch (e) {
      snackbar.error(e instanceof Error ? e.message : 'Log out failed');
    }
  };

  return (
    // The export and the archive on the server, their indicators in the header and their panels belong to every page,
    // for every signed-in user. The header stays at the top while the page scrolls, and on one line: on a phone the
    // console's name gives way before it would wrap or scroll sideways.
    <JobProviders>
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <AppBar position="sticky" color="default" enableColorOnDark>
          <Toolbar>
            <Typography
              variant="h6"
              component={RouterLink}
              to="/"
              noWrap
              sx={{ flexGrow: 1, flexShrink: { xs: 1, sm: 0 }, minWidth: 0, color: 'inherit', textDecoration: 'none' }}
            >
              {APP_NAME}
            </Typography>
            {user ? (
              <>
                <JobIndicators />
                <BuildVersion />
                <Button
                  color="inherit"
                  startIcon={<AccountCircleIcon />}
                  onClick={open}
                  aria-haspopup="menu"
                  sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                >
                  {user.username}
                </Button>
                <Menu anchorEl={anchor} open={anchor !== null} onClose={close} variant="menu">
                  <MenuItem onClick={() => go('/')}>Streams</MenuItem>
                  <MenuItem onClick={() => go('/archive')}>Archive</MenuItem>
                  <MenuItem onClick={() => go('/stages')}>Stages</MenuItem>
                  <MenuItem onClick={() => go('/funding')}>Funding</MenuItem>
                  <MenuItem onClick={() => go('/access')}>Access</MenuItem>
                  <Divider />
                  {themeItems}
                  <Divider />
                  <MenuItem onClick={() => void handleLogOut()}>Log out</MenuItem>
                </Menu>
              </>
            ) : null}
          </Toolbar>
        </AppBar>
        <Container maxWidth="lg" sx={{ py: 4 }}>
          {children}
        </Container>
        {user ? (
          <>
            <ExportPanel />
            <ArchivePanel />
          </>
        ) : null}
      </Box>
    </JobProviders>
  );
}
