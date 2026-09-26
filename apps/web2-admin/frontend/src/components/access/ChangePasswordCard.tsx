import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { passwordProblem } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { useAuth } from '../../auth';
import { PASSWORD_MISMATCH, PASSWORD_RULE } from '../../authMessages';
import { formatDateTime } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { useSnackbar } from '../Snackbar';

const EMPTY = { current: '', next: '', again: '' };

/**
 * Changing your own password, which also signs out every other browser you
 * were logged in with. That is the point of doing it after a password leaks,
 * so the form says it before the fact rather than after.
 */
export function ChangePasswordCard() {
  const { user, setUser } = useAuth();
  const snackbar = useSnackbar();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (field: keyof typeof EMPTY, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const username = user?.username ?? '';
  const nextError =
    form.next === '' ? null : passwordProblem(form.next, username);
  const againError =
    form.again === '' || form.again === form.next ? null : PASSWORD_MISMATCH;

  const complete =
    form.current !== '' && form.next !== '' && form.again !== '';
  const valid = complete && nextError === null && againError === null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || !valid) return;

    setError(null);
    setSaving(true);
    try {
      const updated = await api.changePassword({
        currentPassword: form.current,
        newPassword: form.next,
      });
      if (updated) setUser(updated);
      setForm(EMPTY);
      snackbar.success(
        'Password changed. Your other browsers were signed out.',
      );
    } catch (caught) {
      setError(errorMessage(caught, 'Failed to change the password'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, maxWidth: 520 }}>
      <Stack spacing={2}>
        <Stack spacing={0.5}>
          <Typography variant="h6">Change my password</Typography>
          <Typography variant="body2">
            Logged in as <strong>{username}</strong>
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Password last changed {formatDateTime(user?.passwordChangedAt)}
          </Typography>
        </Stack>

        <Typography variant="body2" color="text.secondary">
          This browser stays signed in. Every other one is signed out.
        </Typography>

        <Stack spacing={2} component="form" onSubmit={submit} noValidate>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            id="current-password"
            label="Current password"
            type="password"
            value={form.current}
            onChange={(e) => set('current', e.target.value)}
            autoComplete="current-password"
            disabled={saving}
            fullWidth
          />
          <TextField
            id="new-password"
            label="New password"
            type="password"
            value={form.next}
            onChange={(e) => set('next', e.target.value)}
            error={nextError !== null}
            helperText={nextError ?? PASSWORD_RULE}
            autoComplete="new-password"
            disabled={saving}
            fullWidth
          />
          <TextField
            id="confirm-password"
            label="Repeat new password"
            type="password"
            value={form.again}
            onChange={(e) => set('again', e.target.value)}
            error={againError !== null}
            helperText={againError ?? ' '}
            autoComplete="new-password"
            disabled={saving}
            fullWidth
          />
          <Button
            type="submit"
            variant="contained"
            disabled={saving || !valid}
            sx={{ alignSelf: 'flex-start' }}
          >
            {saving ? 'Saving…' : 'Change password'}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
