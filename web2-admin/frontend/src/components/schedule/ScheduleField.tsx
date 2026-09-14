import { Chip, Stack, Typography } from '@mui/material';
import { DesktopDateTimePicker } from '@mui/x-date-pickers/DesktopDateTimePicker';
import dayjs from 'dayjs';

import {
  dateTimeLocalToDayjs,
  dayjsToDateTimeLocal,
  describeSchedule,
  parseDateTimeLocalValue,
  quickPicks,
} from './scheduleTime';

export interface ScheduleFieldProps {
  /** A `datetime-local` value, i.e. local wall-clock time, or ''. */
  value: string;
  onChange: (value: string) => void;
  error?: boolean;
  disabled?: boolean;
  /** Why the field is locked, when it is; the backend says the same sentence. */
  helperText?: string;
}

/**
 * One field for the one question an operator answers most often. The picker
 * opens a calendar beside a 24-hour clock for a date that needs choosing; the
 * chips underneath cover the times that get chosen without looking, and the
 * caption spells the answer back with how far off it is.
 *
 * dayjs lives at this boundary only: the form state is the same
 * `datetime-local` string the API helpers have always converted.
 */
export function ScheduleField({
  value,
  onChange,
  error = false,
  disabled = false,
  helperText,
}: ScheduleFieldProps) {
  const now = new Date();
  const picks = quickPicks(now);
  const caption = describeSchedule(value, now);

  // A stream that already went live is scheduled in the past by definition,
  // and so is any older draft. Flagging that as invalid would paint the field
  // red for a value the operator cannot change anyway, so the floor is only
  // applied while the field is actually accepting a new time.
  const current = parseDateTimeLocalValue(value);
  const alreadyPast = current !== null && current.getTime() < now.getTime();
  const floor = disabled || alreadyPast ? undefined : dayjs(now);

  return (
    <Stack spacing={1}>
      <DesktopDateTimePicker
        label="Scheduled Start Time *"
        value={dateTimeLocalToDayjs(value)}
        onChange={(next) => onChange(dayjsToDateTimeLocal(next))}
        disabled={disabled}
        ampm={false}
        disablePast={floor !== undefined}
        minDateTime={floor}
        format="ddd DD MMM YYYY, HH:mm"
        slotProps={{
          textField: {
            id: 'scheduled-time',
            fullWidth: true,
            error,
            helperText,
          },
          // MUI's dark palette gives raised Paper a lightening overlay; the
          // popover reads as a floating grey slab next to the outlined form
          // unless it is told to keep the surface colour.
          desktopPaper: {
            variant: 'outlined',
            sx: { backgroundImage: 'none', bgcolor: 'background.paper' },
          },
          actionBar: { actions: ['today', 'accept'] },
        }}
      />
      {disabled ? null : (
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          {picks.map((pick) => (
            <Chip
              key={pick.key}
              label={pick.label}
              size="small"
              variant="outlined"
              clickable
              onClick={() => onChange(pick.value)}
            />
          ))}
        </Stack>
      )}
      {caption ? (
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      ) : null}
    </Stack>
  );
}
