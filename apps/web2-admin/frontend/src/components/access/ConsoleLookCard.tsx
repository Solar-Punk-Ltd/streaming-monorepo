import { useState, type FormEvent } from 'react';
import { Alert, Button, FormControlLabel, Paper, Radio, RadioGroup, Stack, Typography } from '@mui/material';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { useThemeChoice } from '../../theme/ThemeChoiceProvider';
import { ThemeSwatch } from '../../theme/ThemeSwatch';
import { ADMIN_THEME_NAMES, isAdminThemeName, type AdminThemeName } from '../../theme/themeNames';
import { THEME_TOKENS } from '../../theme/tokens';
import { useSnackbar } from '../Snackbar';

/**
 * The look this host's console starts in, for admins. Saved in the admin's database, so every browser that opens
 * this host wears it, the login page included, unless its admin picked a look of their own in the user menu.
 */
export function ConsoleLookCard() {
  const { hostLook, hostLookChanged } = useThemeChoice();
  const snackbar = useSnackbar();
  // Null until the admin chooses, so the card shows the host's look as it arrives rather than as it was at mount.
  const [chosen, setChosen] = useState<AdminThemeName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = chosen ?? hostLook;
  const changed = selected !== hostLook;

  // Catches every failure into the card's error line, so the form calls it without awaiting.
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !changed) return;

    setSaving(true);
    setError(null);
    try {
      const stored = await api.setDefaultTheme(selected);
      hostLookChanged(stored);
      setChosen(null);
      snackbar.success(`This host's console now starts in ${THEME_TOKENS[stored].label}.`);
    } catch (caught) {
      setError(errorMessage(caught, "This host's console look could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, maxWidth: 520 }}>
      <Stack spacing={2} component="form" onSubmit={(event) => void submit(event)} noValidate>
        <Typography variant="h6" id="console-look-heading">
          Console look
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          The look this host&apos;s console starts in, the login page included. Anyone who picked a look of their own
          under Theme in the user menu keeps it.
        </Typography>

        <RadioGroup
          aria-labelledby="console-look-heading"
          value={selected}
          onChange={(event) => {
            if (isAdminThemeName(event.target.value)) setChosen(event.target.value);
          }}
        >
          {ADMIN_THEME_NAMES.map((name) => (
            <FormControlLabel
              key={name}
              value={name}
              disabled={saving}
              control={<Radio />}
              label={
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <ThemeSwatch name={name} />
                  <span>{THEME_TOKENS[name].label}</span>
                </Stack>
              }
            />
          ))}
        </RadioGroup>

        {error ? <Alert severity="error">{error}</Alert> : null}

        <Button type="submit" variant="contained" disabled={saving || !changed} sx={{ alignSelf: 'flex-start' }}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Stack>
    </Paper>
  );
}
