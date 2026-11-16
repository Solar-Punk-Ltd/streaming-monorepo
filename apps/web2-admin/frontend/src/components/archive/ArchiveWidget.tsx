import ArchiveIcon from '@mui/icons-material/Archive';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import { IconButton, LinearProgress, Paper, Stack, Typography } from '@mui/material';

import { errorMessage } from '../../errors';
import { useSnackbar } from '../Snackbar';
import {
  archiveMoving,
  archiveNeedsDecision,
  archivePercent,
  archiveQualities,
  archiveWidgetLine,
} from './archiveJobText';
import { useArchive } from './ArchiveProvider';

/**
 * The archive on the server, among the job widgets in the top right of every page for every signed-in user, from the
 * moment it starts: its stream, its qualities and where it stands. Clicking it opens the archive panel, and so does
 * its open button, which a keyboard reaches. It says "Paused: needs a decision" when a pause asks for one. A finished
 * archive says so, and stays until each user closes it for themselves.
 */
export function ArchiveWidget() {
  const { current, openPanel, act } = useArchive();
  const snackbar = useSnackbar();
  if (!current) return null;
  if (current.state === 'done' && current.dismissed) return null;
  const decision = archiveNeedsDecision(current);
  const percent = archivePercent(current);

  return (
    <Paper
      elevation={6}
      role="status"
      aria-label="archive"
      onClick={() => openPanel(null)}
      sx={{
        p: 1.5,
        cursor: 'pointer',
        borderLeft: 4,
        borderColor: decision ? 'warning.main' : current.state === 'done' ? 'success.main' : 'primary.main',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <ArchiveIcon fontSize="small" />
        <Typography variant="subtitle2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
          {current.streamTitle} · {archiveQualities(current)}
        </Typography>
        <IconButton
          size="small"
          aria-label="open the archive"
          onClick={(event) => {
            event.stopPropagation();
            openPanel(null);
          }}
        >
          <OpenInFullIcon fontSize="small" />
        </IconButton>
        {current.state === 'done' ? (
          <IconButton
            size="small"
            aria-label="close the archive"
            onClick={(event) => {
              event.stopPropagation();
              act({ action: 'dismiss' }).catch((error: unknown) =>
                snackbar.error(errorMessage(error, 'It could not be closed.')),
              );
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Stack>
      <Typography variant="body2" noWrap sx={{ color: decision ? 'warning.main' : 'text.secondary' }}>
        {archiveWidgetLine(current)}
      </Typography>
      {archiveMoving(current) ? (
        <LinearProgress
          sx={{ mt: 1 }}
          variant={percent === null ? 'indeterminate' : 'determinate'}
          value={percent ?? 0}
        />
      ) : null}
    </Paper>
  );
}
