import { useState, type MouseEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  AppBar,
  Box,
  Button,
  Container,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
} from '@mui/material';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import type { ReactNode } from 'react';

import { useAuth } from '../auth';
import { useSnackbar } from './Snackbar';

export const APP_NAME = 'Stream Admin';

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logOut } = useAuth();
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

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
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" color="default" enableColorOnDark>
        <Toolbar>
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            sx={{ flexGrow: 1, color: 'inherit', textDecoration: 'none' }}
          >
            {APP_NAME}
          </Typography>
          {user ? (
            <>
              <Button
                color="inherit"
                startIcon={<AccountCircleIcon />}
                onClick={open}
                aria-haspopup="menu"
              >
                {user.username}
              </Button>
              <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
                <MenuItem onClick={() => go('/')}>My Streams</MenuItem>
                <MenuItem onClick={() => go('/access')}>Access</MenuItem>
                <MenuItem onClick={() => void handleLogOut()}>Log out</MenuItem>
              </Menu>
            </>
          ) : null}
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        {children}
      </Container>
    </Box>
  );
}
