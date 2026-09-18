import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { SignedOutReason } from '../api';
import { useAuth } from '../auth';
import { FIRST_USER_COMMAND, SIGN_IN_MESSAGES } from '../authMessages';
import { APP_NAME } from '../components/AppShell';
import { ValueField } from '../components/ValueField';

/**
 * What the page says above the form, for each way of arriving signed out.
 * Arriving with no session at all needs no notice: the form is the message.
 */
const NOTICES: Record<SignedOutReason, string | null> = {
  ended: SIGN_IN_MESSAGES.sessionEnded,
  noUsers: SIGN_IN_MESSAGES.noUsers,
  unreachable: SIGN_IN_MESSAGES.unreachable,
  notSignedIn: null,
};

export function LoginPage() {
  const { user, loading, reason, logIn } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 12 }}>
        <CircularProgress aria-label="Checking your session" />
      </Box>
    );
  }

  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }

  const notice = NOTICES[reason];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const result = await logIn(username.trim(), password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setPassword('');
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      }}
    >
      <Card sx={{ width: 420 }}>
        <CardContent>
          <Typography variant="h5" component="h1" gutterBottom>
            {APP_NAME}
          </Typography>
          <Box component="form" onSubmit={submit} noValidate>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {error ? <Alert severity="error">{error}</Alert> : null}
              {notice && !error ? (
                <Alert severity={reason === 'noUsers' ? 'info' : 'warning'}>
                  <Stack spacing={1}>
                    <span>{notice}</span>
                    {reason === 'noUsers' ? (
                      <ValueField
                        label="Command"
                        value={FIRST_USER_COMMAND}
                        helperText="Run it on the host, then log in with that user."
                      />
                    ) : null}
                  </Stack>
                </Alert>
              ) : null}
              <TextField
                id="username"
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                disabled={busy}
                // A username is lower case by database constraint, and a phone
                // capitalises the first letter of a text field by default.
                slotProps={{
                  htmlInput: {
                    autoCapitalize: 'none',
                    autoCorrect: 'off',
                    spellCheck: false,
                  },
                }}
                autoFocus
                fullWidth
              />
              <TextField
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={busy}
                fullWidth
              />
              <Button
                type="submit"
                variant="contained"
                disabled={busy || !username.trim() || !password}
              >
                {busy ? 'Logging in…' : 'Log in'}
              </Button>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
