import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Grid2 as Grid,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import {
  STREAM_LIMITS,
  type MediaType,
  type Stream,
  type StreamInput,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import {
  errorMessage,
  MEDIA_TYPE_LOCKED,
  SCHEDULE_LOCKED,
  UNSUPPORTED_IMAGE_TYPE,
} from '../errors';
import {
  dateTimeLocalValueToIso,
  isoToDateTimeLocalValue,
} from '../dateUtil';
import {
  DescriptionField,
  MediaTypeField,
  NameField,
  TagsField,
  THUMBNAIL_MIME_TYPES,
  ThumbnailField,
} from '../components/StreamFormFields';
import { ScheduleField } from '../components/schedule/ScheduleField';
import { nextFullHourValue } from '../components/schedule/scheduleTime';
import { useSnackbar } from '../components/Snackbar';

/** msrs-client's messages, so the two consoles fail the same way. */
export const ERROR_MESSAGES = {
  NAME_REQUIRED: 'Stream name is required',
  DESCRIPTION_REQUIRED: 'Description is required',
  SCHEDULED_TIME_REQUIRED: 'Scheduled start time is required',
  THUMBNAIL_TOO_LARGE: 'Thumbnail file size must be less than 5MB',
};

/**
 * The required fields in the order the form asks for them. One table, so the
 * check that blocks a submit and the check that decides a message has been
 * answered can never disagree about what "filled in" means.
 */
const REQUIRED: { message: string; filled: (form: FormState) => boolean }[] = [
  {
    message: ERROR_MESSAGES.NAME_REQUIRED,
    filled: (form) => Boolean(form.title.trim()),
  },
  {
    message: ERROR_MESSAGES.DESCRIPTION_REQUIRED,
    filled: (form) => Boolean(form.description.trim()),
  },
  {
    message: ERROR_MESSAGES.SCHEDULED_TIME_REQUIRED,
    filled: (form) => Boolean(form.scheduledStartTime),
  },
];

function firstMissing(form: FormState): string | null {
  return REQUIRED.find((rule) => !rule.filled(form))?.message ?? null;
}

interface FormState {
  title: string;
  description: string;
  tags: string[];
  mediaType: MediaType;
  /** A `datetime-local` value, i.e. local wall-clock time, or ''. */
  scheduledStartTime: string;
}

const EMPTY: FormState = {
  title: '',
  description: '',
  tags: [],
  mediaType: 'video',
  scheduledStartTime: '',
};

/**
 * A new stream starts at the next full hour rather than empty: the operator
 * either accepts it or moves it, and neither costs a trip to the calendar.
 */
function freshForm(): FormState {
  return { ...EMPTY, scheduledStartTime: nextFullHourValue(new Date()) };
}

/**
 * The form state as the contract wants it, or null when the schedule is not a
 * time this can send. The API requires a scheduled start now, so a value the
 * conversion cannot read is the same failure as an empty field rather than a
 * null quietly put on the wire.
 */
function toInput(form: FormState): StreamInput | null {
  const scheduledStartTime = dateTimeLocalValueToIso(form.scheduledStartTime);
  if (!scheduledStartTime) return null;
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    tags: form.tags,
    mediaType: form.mediaType,
    scheduledStartTime,
  };
}

export function StreamFormPage() {
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const snackbar = useSnackbar();

  const [form, setForm] = useState<FormState>(() =>
    isEdit ? EMPTY : freshForm(),
  );
  const [loaded, setLoaded] = useState<Stream | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Thumbnail is three pieces of state: what the server has, what the
  // operator just picked, and whether they asked for the stored one to go.
  const [picked, setPicked] = useState<File | null>(null);
  const [removeStored, setRemoveStored] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    // A "… is required" message is about the form as it was when Create was
    // pressed. Leaving it up once the operator has typed the missing value
    // paints a filled field red and contradicts what they are looking at, so
    // the message goes the moment the field it names is answered. Anything
    // else on screen — a rejected thumbnail, a failed save — is about
    // something this keystroke did not touch, and stays.
    const rule = REQUIRED.find((r) => r.message === error);
    if (rule?.filled(next)) setError(null);
  };

  useEffect(() => {
    // One component serves /create and /edit/:id, so a change of route param
    // has to clear everything the previous stream put here — an unsaved file
    // pick included, or it would be applied to the wrong stream on save.
    setPicked(null);
    setRemoveStored(false);
    setError(null);
    if (!id) {
      setLoaded(null);
      setForm(freshForm());
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .fetchStream(id)
      .then((stream) => {
        if (cancelled) return;
        setLoaded(stream);
        setForm({
          title: stream.title,
          description: stream.description,
          tags: stream.tags,
          mediaType: stream.mediaType,
          scheduledStartTime: isoToDateTimeLocalValue(
            stream.scheduledStartTime,
          ),
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, 'Failed to load the stream'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The object URL is created in an effect, not in a memo, so its revoke is
  // tied to the same lifecycle that created it. jsdom has no object URLs and
  // the preview is decoration, so it is skipped there rather than guarded for.
  const [pickedPreview, setPickedPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!picked || typeof URL.createObjectURL !== 'function') {
      setPickedPreview(null);
      return;
    }
    const url = URL.createObjectURL(picked);
    setPickedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  // Once an encoder has connected, two fields stop being editable. The media
  // type is half of the ingest address the streamer already has; the schedule
  // is a promise about a stream that has already started, and viewers have
  // read it off the catalogue entry. Everything else stays editable, live
  // included — a typo in a title is worth fixing mid-broadcast.
  //
  // A stream that went live without a stored schedule (a row the API created
  // before one was required) has no promise to protect, and the API will not
  // accept a save without a time, so the field stays open until it has one.
  // The backend applies the same exception.
  const hasGoneLive = loaded?.status === 'live' || loaded?.status === 'vod';
  const mediaTypeLocked = loaded?.status === 'published' || hasGoneLive;
  const scheduleLocked = hasGoneLive && loaded?.scheduledStartTime !== null;

  const storedThumbnail =
    loaded?.hasThumbnail && !removeStored && !picked
      ? api.thumbnailUrl(loaded)
      : null;

  const pickThumbnail = (file: File) => {
    // `accept` is a hint the operator can bypass with "all files", so the
    // type is checked here too rather than surfacing as a 415 after the row
    // has already been saved.
    if (!(THUMBNAIL_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(UNSUPPORTED_IMAGE_TYPE);
      return;
    }
    if (file.size > STREAM_LIMITS.THUMBNAIL_MAX_BYTES) {
      setError(ERROR_MESSAGES.THUMBNAIL_TOO_LARGE);
      return;
    }
    setError(null);
    setPicked(file);
    setRemoveStored(false);
  };

  const removeThumbnail = () => {
    setPicked(null);
    if (loaded?.hasThumbnail) setRemoveStored(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const invalid = firstMissing(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    const input = toInput(form);
    if (!input) {
      setError(ERROR_MESSAGES.SCHEDULED_TIME_REQUIRED);
      return;
    }
    setError(null);
    setSaving(true);

    let saved: Stream;
    try {
      saved = id
        ? await api.updateStream(id, input)
        : await api.createStream(input);
    } catch (err) {
      setError(
        errorMessage(
          err,
          isEdit ? 'Failed to update stream' : 'Failed to create stream',
        ),
      );
      setSaving(false);
      return;
    }

    // The image travels on its own endpoint, after the row exists. A failure
    // here must not read as "the stream was not saved" — it was, and sending
    // the operator back to a form that would create a second one is worse
    // than moving on with the thumbnail called out.
    try {
      if (picked) {
        await api.uploadThumbnail(saved.id, picked);
      } else if (removeStored) {
        await api.deleteThumbnail(saved.id);
      }
      snackbar.success(isEdit ? 'Stream updated.' : `"${saved.title}" created.`);
    } catch (err) {
      snackbar.error(
        `Stream saved, but the thumbnail did not: ${errorMessage(
          err,
          'the upload failed',
        )}`,
      );
    }

    setSaving(false);
    navigate(`/streams/${saved.id}`);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress aria-label="Loading stream" />
      </Box>
    );
  }

  return (
    // A form is read down one column, and a text field stretched across a
    // 1200px page is harder to fill in, not easier. The heading is capped with
    // the card so the two stay on the same left edge.
    <Stack spacing={3} sx={{ width: '100%', maxWidth: 760, mx: 'auto' }}>
      <Typography variant="h5" component="h1">
        {isEdit ? 'Edit Stream' : 'Create New Stream'}
      </Typography>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Box component="form" onSubmit={submit} noValidate>
          <Stack spacing={3}>
            {error ? <Alert severity="error">{error}</Alert> : null}

            <NameField
              value={form.title}
              onChange={(v) => set('title', v)}
              error={error === ERROR_MESSAGES.NAME_REQUIRED}
              disabled={saving}
            />
            <DescriptionField
              value={form.description}
              onChange={(v) => set('description', v)}
              error={error === ERROR_MESSAGES.DESCRIPTION_REQUIRED}
              disabled={saving}
            />
            {/*
              Two short answers that both grow downwards — a list of chips and
              a time with its shortcuts — so they sit side by side on a wide
              screen and stack on a narrow one.
            */}
            <Grid container spacing={3} alignItems="flex-start">
              <Grid size={{ xs: 12, md: 6 }}>
                <TagsField
                  value={form.tags}
                  onChange={(v) => set('tags', v)}
                  disabled={saving}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                <ScheduleField
                  value={form.scheduledStartTime}
                  onChange={(v) => set('scheduledStartTime', v)}
                  error={error === ERROR_MESSAGES.SCHEDULED_TIME_REQUIRED}
                  disabled={saving || scheduleLocked}
                  helperText={scheduleLocked ? SCHEDULE_LOCKED : undefined}
                />
              </Grid>
            </Grid>
            {/*
              The media type is the `app` half of the ingest stream id, so
              changing it on a published stream would silently invalidate the
              OBS settings the streamer already has. The backend refuses it
              with 409 media_type_locked; the radio says so up front.
            */}
            <MediaTypeField
              value={form.mediaType}
              onChange={(v) => set('mediaType', v)}
              disabled={saving || mediaTypeLocked}
              helperText={mediaTypeLocked ? MEDIA_TYPE_LOCKED : undefined}
            />

            <Divider />

            <ThumbnailField
              previewUrl={pickedPreview ?? storedThumbnail}
              fileName={picked?.name ?? null}
              onPick={pickThumbnail}
              onRemove={removeThumbnail}
              disabled={saving}
            />

            <Stack direction="row" spacing={2}>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving
                  ? isEdit
                    ? 'Updating Stream…'
                    : 'Creating Stream…'
                  : isEdit
                    ? 'Update Stream'
                    : 'Create Stream'}
              </Button>
              <Button onClick={() => navigate(-1)} disabled={saving}>
                Cancel
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Paper>
    </Stack>
  );
}
