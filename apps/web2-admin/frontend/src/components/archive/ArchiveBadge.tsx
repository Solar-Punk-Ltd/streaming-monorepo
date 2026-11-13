import { Chip, Tooltip } from '@mui/material';
import { ARCHIVE_BADGE_TEXT, type StreamArchiveState } from '@streaming-monorepo/web2-admin-common';

import type { ArchiveBadgeProps } from './archiveSeams';

type ChipColor = 'success' | 'warning' | 'error' | 'default';

/** The badge's colour: green while a quality plays from its stamp, amber when protection is reduced or a copy stopped. */
const BADGE_COLOR: Readonly<Record<StreamArchiveState, ChipColor>> = {
  none: 'default',
  partial: 'warning',
  complete: 'success',
  reduced: 'warning',
  outdated: 'default',
  expired: 'error',
};

/** What the badge says on hover: the qualities that play from an archive stamp, and whether only they are listed. */
export function archiveBadgeHint({ archived, archivedOnly }: NonNullable<ArchiveBadgeProps['archive']>): string | null {
  if (archived.length === 0) return null;
  const listed = archivedOnly ? ' The catalogue lists only these.' : '';
  return `Archived: ${archived.join(', ')}.${listed}`;
}

/**
 * The stream list's badge for a stream's archive: `ARCHIVE_BADGE_TEXT` for its state, and nothing for a stream with
 * nothing copied. The Archive page and the stream page show it too.
 */
export function ArchiveBadge({ archive }: ArchiveBadgeProps) {
  if (!archive) return null;
  const text = ARCHIVE_BADGE_TEXT[archive.state];
  if (text === null) return null;
  const chip = <Chip size="small" variant="outlined" color={BADGE_COLOR[archive.state]} label={text} />;
  const hint = archiveBadgeHint(archive);
  return hint ? <Tooltip title={hint}>{chip}</Tooltip> : chip;
}
