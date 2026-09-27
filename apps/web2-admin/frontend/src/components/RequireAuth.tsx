import { Box, CircularProgress } from '@mui/material';
import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../auth';
import { AppShell } from './AppShell';

/**
 * Guards every authenticated route. The auth provider drops the user on any
 * 401, which lands here on the next render and sends the operator to /login
 * with the path they wanted so they resume where they were.
 */
export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 12 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
