import { Autocomplete, Chip, Stack, TextField, Typography } from '@mui/material';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { pickersInputBaseClasses } from '@mui/x-date-pickers/PickersTextField';
import dayjs, { type Dayjs } from 'dayjs';

import { DATE_FORMAT } from '../../dateUtil';
import {
  dateToDayjs,
  dayjsToDateValue,
  describeSchedule,
  firstFreeSlot,
  isSlotPast,
  joinDateTimeLocal,
  parseDateTimeLocalValue,
  parseTypedTime,
  quickPicks,
  slotOptions,
  splitDateTimeLocal,
  todayValue,
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

/** The typing is matched on digits, so `1830`, `18:30` and `18` all find 18:30. */
const digitsOf = (text: string) => text.replace(/\D/g, '');

/**
 * The one question an operator answers most often, asked as two: a calendar
 * for the day and a typeahead for the time. The single datetime picker this
 * replaces put the clock in MUI's two scrolling columns, which is a lot of
 * pointing for "half six"; a list you can type `1830` into is not. The chips
 * underneath still cover the times that get chosen without looking, and the
 * caption spells the whole answer back with how far off it is.
 *
 * dayjs lives at this boundary only: the form state is the same
 * `datetime-local` string the API helpers have always converted.
 */
export function ScheduleField({ value, onChange, error = false, disabled = false, helperText }: ScheduleFieldProps) {
  const now = new Date();
  const picks = quickPicks(now);
  const caption = describeSchedule(value, now);
  const { date, time } = splitDateTimeLocal(value);

  // A stream that already went live is scheduled in the past by definition,
  // and so is any older draft. Flagging that as invalid would paint the field
  // red for a value the operator cannot change anyway, so the floor is only
  // applied while the field is actually accepting a new time.
  const current = parseDateTimeLocalValue(value);
  const alreadyPast = current !== null && current.getTime() < now.getTime();
  const floored = !disabled && !alreadyPast;
  const floor = floored ? dayjs(now) : undefined;

  const handleDate = (next: Dayjs | null) => {
    const nextDate = dayjsToDateValue(next);
    // An empty or half-typed date is no date, and the form's required check
    // is what should say so — hence the empty value rather than a silent hold.
    if (!nextDate) {
      onChange('');
      return;
    }
    // A day on its own is a complete answer to the operator, so it has to be
    // one to the form too: the earliest slot that day still has left.
    const nextTime = time || firstFreeSlot(nextDate, now) || '00:00';
    onChange(joinDateTimeLocal(nextDate, nextTime));
  };

  const handleTime = (typed: string) => {
    const nextTime = parseTypedTime(typed);
    if (!nextTime) return;
    onChange(joinDateTimeLocal(date || todayValue(now), nextTime));
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <DesktopDatePicker
          label="Scheduled Date *"
          value={dateToDayjs(date)}
          onChange={handleDate}
          disabled={disabled}
          disablePast={floored}
          minDate={floor}
          format={DATE_FORMAT}
          sx={{
            flex: '1 1 14rem',
            // The pickers' section field dims a locked date to the faint
            // action.disabled grey, while the time field beside it keeps
            // text.disabled. Keep the two locked fields reading alike.
            [`& .${pickersInputBaseClasses.root}.${pickersInputBaseClasses.disabled}`]: { color: 'text.disabled' },
          }}
          slotProps={{
            textField: {
              id: 'scheduled-date',
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
        <Autocomplete<string, false, true, true>
          id="scheduled-time"
          options={slotOptions(time)}
          value={time}
          onChange={(_event, next) => handleTime(next)}
          disabled={disabled}
          disableClearable
          autoHighlight
          openOnFocus
          autoSelect
          // Free text so an exact minute stays typeable: the menu is a
          // quarter-hour grid, but a stream can start at 18:07 and an operator
          // should not have to fight the field to say so.
          freeSolo
          // A free-text Autocomplete hides its arrow by default, which leaves
          // the field looking like a plain text box; the menu is the point.
          forcePopupIcon
          filterOptions={(options, { inputValue }) => {
            const typed = digitsOf(inputValue);
            if (!typed) return options;
            return options.filter((option) => digitsOf(option).startsWith(typed));
          }}
          getOptionDisabled={(option) => floored && isSlotPast(date || todayValue(now), option, now)}
          sx={{ flex: '1 1 10rem' }}
          renderInput={(params) => <TextField {...params} label="Scheduled Time *" fullWidth error={error} />}
        />
      </Stack>
      {disabled ? null : (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
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
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {caption}
        </Typography>
      ) : null}
    </Stack>
  );
}
