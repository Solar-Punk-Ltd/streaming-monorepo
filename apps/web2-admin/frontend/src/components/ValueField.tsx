import { useEffect, useRef, useState } from 'react';
import { IconButton, Stack, TextField, Tooltip } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import { monoFont } from '../theme/createAdminTheme';
import { CopyButton } from './CopyButton';

/** Fixed width, so the mask does not advertise the secret's length. */
const MASK = '•'.repeat(24);

/**
 * A read-only value the operator pastes somewhere else: a URL, a key, a
 * passphrase. `secret` adds a show/hide toggle and starts hidden. Copy always
 * copies the real value, hidden or not; when no clipboard route works the
 * field reveals and selects itself so a manual copy is still possible.
 */
export function ValueField({
  label,
  value,
  secret = false,
  maskedValue,
  helperText,
}: {
  label: string;
  value: string;
  secret?: boolean;
  /**
   * What to show while hidden, when part of the value is worth reading — an
   * ingest URL whose only secret is its `key=` parameter, say. Defaults to a
   * plain mask.
   */
  maskedValue?: string;
  helperText?: string;
}) {
  const [revealed, setRevealed] = useState(!secret);
  const [selectPending, setSelectPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hidden = secret && !revealed;

  // Selecting has to wait for the reveal to land, or the operator would be
  // handed a selection of bullet characters.
  useEffect(() => {
    if (!selectPending || hidden) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    setSelectPending(false);
  }, [selectPending, hidden]);

  const selectForManualCopy = () => {
    setRevealed(true);
    setSelectPending(true);
  };

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
      <TextField
        label={label}
        value={hidden ? (maskedValue ?? MASK) : value}
        helperText={helperText}
        size="small"
        fullWidth
        inputRef={inputRef}
        slotProps={{
          input: {
            readOnly: true,
            sx: { fontFamily: monoFont, fontSize: 13 },
          },
          // Read-only display, not an editable field: keep it out of the tab
          // order so copy buttons are the next stop after the previous control.
          htmlInput: { 'aria-label': label, tabIndex: -1 },
        }}
      />
      <Stack direction="row" sx={{ pt: 0.5 }}>
        {secret ? (
          <Tooltip title={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
            <IconButton
              size="small"
              aria-label={revealed ? `hide ${label.toLowerCase()}` : `show ${label.toLowerCase()}`}
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? <VisibilityOffIcon fontSize="inherit" /> : <VisibilityIcon fontSize="inherit" />}
            </IconButton>
          </Tooltip>
        ) : null}
        <CopyButton value={value} label={label} onCopyUnavailable={selectForManualCopy} />
      </Stack>
    </Stack>
  );
}
