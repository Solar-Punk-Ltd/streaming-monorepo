import { Box, Button, Checkbox, Stack, Typography } from '@mui/material';

/**
 * Ticking many rows at once on the Stamps and the Chequebooks tabs: Select all and Clear above the tables, and a tick
 * box in front of each group's name. A row is ticked by its key, a batch's id or a node's, so a row two groups list
 * shows ticked in both and is asked for once.
 */

/**
 * The tick column's width, as every funding table has it: a table of fixed column widths takes them from its header,
 * and a small table's checkbox cell is 28 pixels, padding included, which the checkbox would stand out of.
 */
export const CHECKBOX_WIDTH = 56;

/**
 * A small table cell's padding on its left, as MUI pads it, which sets its content in: a row's tick box in the tick
 * column, and the text of the column after it.
 */
const CELL_PADDING = 16;

/** The outlined table's border, which a row's cells stand inside of and a group's name does not. */
const TABLE_BORDER = 1;

/** `ticked` with every one of `keys` ticked, or with every one of them cleared. */
export function withTicks(ticked: ReadonlySet<string>, keys: readonly string[], tick: boolean): ReadonlySet<string> {
  const next = new Set(ticked);
  for (const key of keys) {
    if (tick) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** How many of `keys` are ticked. */
function tickedCount(keys: readonly string[], ticked: ReadonlySet<string>): number {
  return keys.filter((key) => ticked.has(key)).length;
}

/**
 * Select all and Clear, above a tab's tables. Select all ticks every row that has a tick box, `keys`, and Clear
 * unticks every row; each is disabled while it would change nothing a row shows.
 */
export function SelectAllBar({
  keys,
  ticked,
  onTicks,
  onClear,
}: {
  keys: readonly string[];
  ticked: ReadonlySet<string>;
  onTicks: (keys: readonly string[], tick: boolean) => void;
  onClear: () => void;
}) {
  const count = tickedCount(keys, ticked);
  return (
    <Stack direction="row" spacing={1}>
      <Button size="small" disabled={count === keys.length} onClick={() => onTicks(keys, true)}>
        Select all
      </Button>
      <Button size="small" disabled={count === 0} onClick={onClear}>
        Clear
      </Button>
    </Stack>
  );
}

/**
 * A group's name with a tick box in front of it, in a box as wide as the tick column and the table's border, so the
 * tick box stands in line with the rows' tick boxes and the name with the column after them. It ticks every row of the
 * group that has a tick box, `keys`, or clears them when all are ticked; it shows a dash while only some are, and is
 * disabled when the group has none.
 */
export function GroupTitle({
  title,
  label,
  keys,
  ticked,
  onTicks,
}: {
  title: string;
  /** The tick box's name, which says what ticking it asks for, as each row's does. */
  label: string;
  keys: readonly string[];
  ticked: ReadonlySet<string>;
  onTicks: (keys: readonly string[], tick: boolean) => void;
}) {
  const count = tickedCount(keys, ticked);
  const all = keys.length > 0 && count === keys.length;
  return (
    <Stack direction="row" sx={{ alignItems: 'center' }}>
      <Box
        sx={{
          width: CHECKBOX_WIDTH + TABLE_BORDER,
          flexShrink: 0,
          display: 'flex',
          boxSizing: 'border-box',
          paddingLeft: `${TABLE_BORDER + CELL_PADDING}px`,
        }}
      >
        <Checkbox
          checked={all}
          indeterminate={count > 0 && !all}
          disabled={keys.length === 0}
          onChange={() => onTicks(keys, !all)}
          slotProps={{ input: { 'aria-label': label } }}
          sx={{ padding: 0 }}
        />
      </Box>
      <Typography variant="subtitle1" component="h3" sx={{ paddingLeft: `${CELL_PADDING}px`, minWidth: 0 }}>
        {title}
      </Typography>
    </Stack>
  );
}
