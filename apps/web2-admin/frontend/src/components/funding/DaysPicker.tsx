import { InputAdornment, Slider, Stack, TextField, ToggleButton, ToggleButtonGroup } from '@mui/material';

import { acceptsDaysTyping, dayCount, DAYS_PRESETS, DAYS_SLIDER_MAX } from './stamps';

/** The days typed, as a whole number of `least` or more, or null: `readDays` of `stamps.ts` for any least. */
export function readDaysFrom(typed: string, least: number): number | null {
  const text = typed.trim();
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return Number.isSafeInteger(days) && days >= least ? days : null;
}

/**
 * The days of the Stamps tab: a slider from `least` to 365 with three presets, and a field beside it that takes any
 * whole number of days from `least`, with no cap. A top-up buys its days with it, and Buy new the life of a new batch.
 * `problem` is why the days typed cannot be read, shown on hover over the field, or null.
 */
export function DaysPicker({
  days,
  onDays,
  least,
  sliderLabel,
  problem,
  disabled = false,
}: {
  days: string;
  onDays: (days: string) => void;
  least: number;
  sliderLabel: string;
  problem: string | null;
  disabled?: boolean;
}) {
  const read = readDaysFrom(days, least);
  const slider = read !== null ? Math.min(read, DAYS_SLIDER_MAX) : least;
  const preset = read !== null && DAYS_PRESETS.includes(read) ? read : null;
  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: { md: 'center' } }}>
      <Slider
        aria-label={sliderLabel}
        min={least}
        max={DAYS_SLIDER_MAX}
        value={slider}
        disabled={disabled}
        marks={DAYS_PRESETS.map((value) => ({ value }))}
        valueLabelDisplay="auto"
        onChange={(_event, value) => {
          if (typeof value === 'number') onDays(String(value));
        }}
        sx={{ flexGrow: 1, minWidth: 200 }}
      />
      <ToggleButtonGroup
        exclusive
        size="small"
        value={preset}
        disabled={disabled}
        aria-label="Days presets"
        onChange={(_event, next: number | null) => {
          if (next !== null) onDays(String(next));
        }}
      >
        {DAYS_PRESETS.map((value) => (
          <ToggleButton key={value} value={value}>
            {dayCount(value)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <TextField
        size="small"
        value={days}
        disabled={disabled}
        onChange={(e) => {
          if (acceptsDaysTyping(e.target.value)) onDays(e.target.value);
        }}
        error={problem !== null}
        title={problem ?? undefined}
        slotProps={{
          htmlInput: { inputMode: 'numeric', 'aria-label': 'Days' },
          input: { endAdornment: <InputAdornment position="end">days</InputAdornment> },
        }}
        sx={{
          width: 140,
          flexShrink: 0,
          '& .MuiInputBase-input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
        }}
      />
    </Stack>
  );
}
