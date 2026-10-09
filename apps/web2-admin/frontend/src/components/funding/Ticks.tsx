import { Button, Stack } from '@mui/material';

/**
 * Ticking many rows at once on the Stamps and the Chequebooks tabs. A row is ticked by its key, a batch's id or a
 * node's, so a row two groups list shows ticked in both and is asked for once.
 */

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
