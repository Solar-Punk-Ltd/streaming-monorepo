import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import { STREAM_LIMITS, THUMBNAIL_MIME_TYPES, type MediaType } from '@streaming-monorepo/web2-admin-common';

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
    // A repeat is not an error, it is a no-op that clears the box — the same
    // way msrs-client behaves.
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

export function MediaTypeField({
  value,
  onChange,
  disabled = false,
  helperText,
}: {
  value: MediaType;
  onChange: (value: MediaType) => void;
  disabled?: boolean;
  helperText?: string;
}) {
  return (
    <FormControl disabled={disabled}>
      <FormLabel id="media-type-label">Media Type</FormLabel>
      <RadioGroup
        row
        aria-labelledby="media-type-label"
        value={value}
        onChange={(e) => onChange(e.target.value as MediaType)}
      >
        <FormControlLabel value="video" control={<Radio size="small" />} label="Video Stream" />
        <FormControlLabel value="audio" control={<Radio size="small" />} label="Audio Only" />
      </RadioGroup>
      {helperText ? <FormHelperText>{helperText}</FormHelperText> : null}
    </FormControl>
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
