import { EXPORT_ACTIVE_STATES } from '@streaming-monorepo/web2-admin-common';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import { IconButton, LinearProgress, Paper, Stack, Typography } from '@mui/material';

import { errorMessage } from '../../errors';
import { useSnackbar } from '../Snackbar';
import { SaveFileButton } from './ExportPanel';
import { needsDecision, percentRead, widgetLine } from './exportText';
import { useExport } from './ExportProvider';

/**
 * The export on the server, floating in the top right of every page, for every signed-in user, while the panel is
 * closed. Clicking it opens the panel. It stays until the export is done and each user closes it for themselves.
 */
export function ExportWidget() {
  const { current, panel, openPanel, act } = useExport();
  const snackbar = useSnackbar();
  if (!current || panel.open) return null;
  const active = EXPORT_ACTIVE_STATES.includes(current.state);
  if (!active && current.dismissed) return null;
  const decision = needsDecision(current);
  const percent = percentRead(current);

  return (
    <Paper
      elevation={6}
      role="status"
      aria-label="export"
      onClick={() => openPanel(null)}
      sx={{
        position: 'fixed',
        top: 72,
        right: 16,
        width: 300,
        maxWidth: 'calc(100vw - 32px)',
        p: 1.5,
        cursor: 'pointer',
        zIndex: (theme) => theme.zIndex.snackbar,
        borderLeft: 4,
        borderColor: decision ? 'warning.main' : active ? 'primary.main' : 'success.main',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <DownloadIcon fontSize="small" />
        <Typography variant="subtitle2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
          {current.streamTitle} · {current.quality}
        </Typography>
        {current.state === 'done' ? (
          <IconButton
            size="small"
            aria-label="close the export"
            onClick={(event) => {
              event.stopPropagation();
              act('dismiss').catch((error: unknown) => snackbar.error(errorMessage(error, 'It could not be closed.')));
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Stack>
      <Typography variant="body2" noWrap sx={{ color: decision ? 'warning.main' : 'text.secondary' }}>
        {widgetLine(current)}
      </Typography>
      {active ? (
        <LinearProgress
          sx={{ mt: 1 }}
          variant={percent === null ? 'indeterminate' : 'determinate'}
          value={percent ?? 0}
        />
      ) : (
        <SaveFileButton current={current} variant="text" />
      )}
    </Paper>
  );
}
