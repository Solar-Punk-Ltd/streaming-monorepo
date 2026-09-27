import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, Paper, Stack, TextField, Typography } from '@mui/material';
import { passwordProblem, usernameProblem } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { PASSWORD_MISMATCH, PASSWORD_RULE } from '../../authMessages';
import { errorMessage } from '../../errors';
import { useSnackbar } from '../Snackbar';

const EMPTY = { username: '', password: '', again: '' };

/**
 * Adding someone. The password is typed twice and handed over in person, and
 * the new user is expected to change it from their own Access page.
 *
 * Both fields are checked with the shared rules from common, so the form
 * refuses exactly what the API would and says the same thing about it — a
 * second spelling of the rule here is a rule that drifts.
 */
export function AddUserCard({ onAdded }: { onAdded: () => Promise<void> }) {
  const snackbar = useSnackbar();
  const [form, setForm] = useState(EMPTY);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (field: keyof typeof EMPTY, value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const username = form.username.trim();
  // Only complain about what has been typed: an empty field is not yet wrong.
  const usernameError = username === '' ? null : usernameProblem(username);
  const passwordError = form.password === '' ? null : passwordProblem(form.password, username);
  const againError = form.again === '' || form.again === form.password ? null : PASSWORD_MISMATCH;

  const complete = username !== '' && form.password !== '' && form.again !== '';
  const valid = complete && usernameError === null && passwordError === null && againError === null;

  // Catches every failure into the form's error line, so the form calls it without awaiting.
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !valid) return;

    setPending(true);
    setError(null);
    try {
      await api.addUser({ username, password: form.password, admin });
      setForm(EMPTY);
      setAdmin(false);
      snackbar.success(`Added ${username}`);
      await onAdded();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not add the user.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, maxWidth: 520 }}>
      <Stack spacing={2} component="form" onSubmit={(event) => void submit(event)} noValidate>
        <Typography variant="h6">Add user</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Type a starting password, tell it to them in person, and ask them to change it here once they are in.
        </Typography>

        <TextField
          id="new-username"
          label="Username"
          value={form.username}
          onChange={(e) => set('username', e.target.value)}
          error={usernameError !== null}
          helperText={usernameError ?? 'Lower case letters, digits, dot, underscore or dash.'}
          autoComplete="off"
          disabled={pending}
          slotProps={{
            htmlInput: {
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
            },
          }}
          fullWidth
        />
        <TextField
          id="new-user-password"
          label="Password"
          type="password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          error={passwordError !== null}
          helperText={passwordError ?? PASSWORD_RULE}
          autoComplete="new-password"
          disabled={pending}
          fullWidth
        />
        <TextField
          id="new-user-password-again"
          label="Password again"
          type="password"
          value={form.again}
          onChange={(e) => set('again', e.target.value)}
          error={againError !== null}
          helperText={againError ?? ' '}
          autoComplete="new-password"
          disabled={pending}
          fullWidth
        />

        <FormControlLabel
          control={<Checkbox checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={pending} />}
          label="Admin: can add and remove users, and sign anyone out"
        />

        {error ? <Alert severity="error">{error}</Alert> : null}

        <Button type="submit" variant="contained" disabled={pending || !valid} sx={{ alignSelf: 'flex-start' }}>
          {pending ? 'Adding…' : 'Add user'}
        </Button>
      </Stack>
    </Paper>
  );
}
