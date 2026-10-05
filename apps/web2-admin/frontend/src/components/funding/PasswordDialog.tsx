import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from '@mui/material';

/**
 * Asks for the operator's own password before a funding write, as every send from the brand wallet and every address
 * confirmation does. Open for as long as it is mounted, so the password it holds goes when it closes.
 */
export function PasswordDialog({
  title,
  children,
  confirmText,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmText: string;
  busy: boolean;
  error: string | null;
  /** Answers `wrong-password` when the API refused the password, which empties the field for another try. */
  onConfirm: (password: string) => Promise<'wrong-password' | void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || password === '') return;
    if ((await onConfirm(password)) === 'wrong-password') setPassword('');
  };

  return (
    <Dialog open onClose={busy ? undefined : onCancel} maxWidth="sm" fullWidth>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {children}
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TextField
              id="funding-password"
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={busy || password === ''}>
            {confirmText}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
