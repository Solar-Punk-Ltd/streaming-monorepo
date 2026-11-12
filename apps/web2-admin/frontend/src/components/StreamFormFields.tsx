import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Alert, Box, Button, Chip, FormLabel, Stack, TextField, Typography } from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import { STREAM_LIMITS, THUMBNAIL_MIME_TYPES, type StreamLink } from '@streaming-monorepo/web2-admin-common';

/**
 * The fields, labels and limits are msrs-client's, reproduced in MUI so the
 * console its operators already know keeps reading the same.
 */

export function NameField({
  value,
  onChange,
  error = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: boolean;
  disabled?: boolean;
}) {
  return (
    <TextField
      id="stream-name"
      label="Stream Name *"
      placeholder="Enter your stream name"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      helperText={`${value.length}/${STREAM_LIMITS.TITLE_MAX}`}
      error={error}
      disabled={disabled}
      fullWidth
      slotProps={{
        htmlInput: { maxLength: STREAM_LIMITS.TITLE_MAX },
        formHelperText: { sx: { textAlign: 'right', m: 0, mt: 0.5 } },
      }}
    />
  );
}

export function DescriptionField({
  value,
  onChange,
  error = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: boolean;
  disabled?: boolean;
}) {
  return (
    <TextField
      id="stream-description"
      label="Description *"
      placeholder="Describe your stream..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      helperText={`${value.length}/${STREAM_LIMITS.DESCRIPTION_MAX}`}
      error={error}
      disabled={disabled}
      multiline
      rows={4}
      fullWidth
      slotProps={{
        htmlInput: { maxLength: STREAM_LIMITS.DESCRIPTION_MAX },
        formHelperText: { sx: { textAlign: 'right', m: 0, mt: 0.5 } },
      }}
    />
  );
}

export function TagsField({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const full = value.length >= STREAM_LIMITS.TAGS_MAX;

  const addTag = () => {
    const trimmed = draft.trim();
    if (!trimmed || full) return;
    // A repeat clears the box without an error, as msrs-client does.
    if (!value.includes(trimmed)) onChange([...value, trimmed]);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          id="stream-tags"
          label="Tags"
          placeholder={full ? `Maximum ${STREAM_LIMITS.TAGS_MAX} tags reached` : 'Add a tag and press Enter'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          helperText={`${value.length}/${STREAM_LIMITS.TAGS_MAX} tags`}
          disabled={disabled || full}
          fullWidth
          slotProps={{
            htmlInput: { maxLength: STREAM_LIMITS.TAG_MAX_LENGTH },
            formHelperText: { sx: { textAlign: 'right', m: 0, mt: 0.5 } },
          }}
        />
        <Button onClick={addTag} disabled={disabled || !draft.trim() || full} sx={{ mt: 0.5 }}>
          Add
        </Button>
      </Stack>
      {value.length > 0 ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {value.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              size="small"
              onDelete={disabled ? undefined : () => onChange(value.filter((t) => t !== tag))}
              // Chip clones the delete icon and attaches its own onClick; the
              // label is what tells ten otherwise identical X buttons apart.
              deleteIcon={<CancelIcon aria-label={`Remove tag ${tag}`} />}
            />
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

/** A link row with nothing typed in it, which a save leaves out. */
export function isBlankLink(link: StreamLink): boolean {
  return !link.label.trim() && !link.href.trim();
}

/** Whether a row can be saved as it stands: a label, and an address the API takes. */
export function isCompleteLink(link: StreamLink): boolean {
  if (!link.label.trim()) return false;
  try {
    return new URL(link.href.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The labels offered as shortcuts: the places a broadcast is usually streamed to beside Swarm. Short, a
 * site's name alone, because the viewer sets a stream's links side by side in one row.
 */
const LINK_SHORTCUTS = ['X', 'YouTube', 'Twitch'];

/**
 * The other places a stream can be watched, a label and an address each. The
 * viewer shows them as links under the stream, in this order.
 */
export function LinksField({
  value,
  onChange,
  error = false,
  disabled = false,
}: {
  value: StreamLink[];
  onChange: (value: StreamLink[]) => void;
  /** True when a save was refused over a row, which marks the rows that caused it. */
  error?: boolean;
  disabled?: boolean;
}) {
  const full = value.length >= STREAM_LIMITS.LINKS_MAX;
  const setRow = (index: number, change: Partial<StreamLink>) =>
    onChange(value.map((link, i) => (i === index ? { ...link, ...change } : link)));
  const addRow = (label = '') => {
    if (!full) onChange([...value, { label, href: '' }]);
  };
  const shortcuts = LINK_SHORTCUTS.filter((label) => !value.some((link) => link.label.trim() === label));

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
        <FormLabel>Links</FormLabel>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {value.length}/{STREAM_LIMITS.LINKS_MAX} links
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Other places this stream can be watched, such as X or YouTube. Viewers see them in one row under the stream, so
        keep each label short: the site’s name is enough.
      </Typography>
      {value.map((link, index) => {
        const refused = error && !isBlankLink(link) && !isCompleteLink(link);
        return (
          <Stack key={index} direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: 'flex-start' }}>
            <TextField
              label={`Link ${index + 1} label`}
              placeholder="X"
              value={link.label}
              onChange={(e) => setRow(index, { label: e.target.value })}
              error={refused && !link.label.trim()}
              disabled={disabled}
              size="small"
              sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0 }}
              slotProps={{ htmlInput: { maxLength: STREAM_LIMITS.LINK_LABEL_MAX } }}
            />
            <TextField
              label={`Link ${index + 1} address`}
              placeholder="https://"
              value={link.href}
              onChange={(e) => setRow(index, { href: e.target.value })}
              error={refused && Boolean(link.label.trim())}
              disabled={disabled}
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: STREAM_LIMITS.LINK_HREF_MAX, inputMode: 'url' } }}
            />
            <Button
              size="small"
              color="error"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              disabled={disabled}
              aria-label={`Remove link ${index + 1}`}
              sx={{ mt: { sm: 0.5 }, flexShrink: 0 }}
            >
              Remove
            </Button>
          </Stack>
        );
      })}
      {full ? null : (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button size="small" variant="outlined" onClick={() => addRow()} disabled={disabled}>
            Add link
          </Button>
          {shortcuts.map((label) => (
            <Button key={label} size="small" onClick={() => addRow(label)} disabled={disabled}>
              + {label}
            </Button>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function ThumbnailField({
  previewUrl,
  fileName,
  onPick,
  onRemove,
  error = null,
  disabled = false,
}: {
  previewUrl: string | null;
  fileName: string | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  /** Why the last pick was refused, shown under the picker. */
  error?: string | null;
  disabled?: boolean;
}) {
  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    // Reset so picking the same file twice still fires a change event.
    e.target.value = '';
  };

  return (
    <Stack spacing={1}>
      <FormLabel htmlFor="stream-thumbnail">Upload Thumbnail (Max 5MB)</FormLabel>
      {/*
        A native file input, like msrs-client's, so the label and the picker
        stay plain and testable. Its browser-chrome button is light even in a
        dark theme, so the theme is applied to it by hand.
      */}
      <Box
        component="input"
        id="stream-thumbnail"
        type="file"
        // `image/*` would let the picker offer SVG and HEIC, which the
        // thumbnail endpoint refuses, so only its four types are offered.
        accept={THUMBNAIL_MIME_TYPES.join(',')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'stream-thumbnail-error' : undefined}
        onChange={onInputChange}
        disabled={disabled}
        sx={{
          fontSize: 14,
          color: 'text.secondary',
          '&::file-selector-button': {
            mr: 1.5,
            px: 1.5,
            py: 0.75,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'action.hover',
            color: 'text.primary',
            font: 'inherit',
            cursor: disabled ? 'default' : 'pointer',
          },
        }}
      />
      {error ? (
        <Alert id="stream-thumbnail-error" severity="error">
          {error}
        </Alert>
      ) : null}
      {previewUrl || fileName ? (
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          {previewUrl ? (
            <Box
              component="img"
              src={previewUrl}
              alt="Thumbnail preview"
              sx={{
                width: 160,
                height: 90,
                objectFit: 'cover',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ) : null}
          <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
            {fileName ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {fileName}
              </Typography>
            ) : null}
            <Button size="small" color="error" onClick={onRemove} disabled={disabled}>
              Remove
            </Button>
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );
}
