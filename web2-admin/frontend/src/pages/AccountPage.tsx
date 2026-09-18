import { useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import * as api from '../api';
import { useAuth } from '../auth';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { useSnackbar } from '../components/Snackbar';

const MIN_PASSWORD_LENGTH = 8;

export function AccountPage() {
  const { user, setUser } = useAuth();
  const snackbar = useSnackbar();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const me = await api.changePassword({ currentPassword, newPassword });
      setUser(me.user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // The backend drops every other session of this user, so say so.
      snackbar.success(
        'Password changed. Other sessions for this account were signed out.',
      );
    } catch (err) {
      setError(errorMessage(err, 'Failed to change the password'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        Account
      </Typography>

      <Paper variant="outlined" sx={{ p: 3, maxWidth: 520 }}>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="body2">
              Signed in as <strong>{user?.username}</strong>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Password last changed {formatDateTime(user?.passwordChangedAt)}
            </Typography>
          </Stack>

          <Typography variant="h6">Change password</Typography>

          <Box component="form" onSubmit={submit} noValidate>
            <Stack spacing={2}>
              {error ? <Alert severity="error">{error}</Alert> : null}
              <TextField
                id="current-password"
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                fullWidth
              />
              <TextField
                id="new-password"
                label="New password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                fullWidth
              />
              <TextField
                id="confirm-password"
                label="Repeat new password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                fullWidth
              />
              <Button
                type="submit"
                variant="contained"
                disabled={
                  saving || !currentPassword || !newPassword || !confirmPassword
                }
                sx={{ alignSelf: 'flex-start' }}
              >
                {saving ? 'Saving…' : 'Change password'}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>
    </Stack>
  );
}
