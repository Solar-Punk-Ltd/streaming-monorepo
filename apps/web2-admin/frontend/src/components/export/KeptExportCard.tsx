import { EXPORT_ACTIVE_STATES } from '@streaming-monorepo/web2-admin-common';
import { Box, Button, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';

import { SaveFileButton } from './ExportPanel';
import { formatBytes, formatTook, formatUtc, percentRead, statusLine } from './exportText';
import { useExport } from './ExportProvider';

/**
 * On a stream's page, above its OBS details: the file exported from this stream and kept on the server, to save again
 * without reading Swarm, or the export of it that is running. Nothing when the export on the server is another
 * stream's, or there is none.
 */
export function KeptExportCard({ streamId }: { streamId: string }) {
  const { current, openPanel } = useExport();
  if (!current || current.streamId !== streamId) return null;
  const active = EXPORT_ACTIVE_STATES.includes(current.state);
  const percent = percentRead(current);
  const took = formatTook(current.startedAt, current.finishedAt);

  return (
    <Paper sx={{ p: 3 }} component="section" aria-label="downloaded file">
      <Typography variant="h6" component="h2" gutterBottom>
        {active ? 'Export in progress' : 'Downloaded file'}
      </Typography>
      {active ? (
        <Stack spacing={1.5}>
          <Typography variant="body2">
            {current.quality}: {statusLine(current)}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Started by {current.startedByYou ? 'you' : current.startedBy} at {formatUtc(current.startedAt)}
          </Typography>
          <LinearProgress variant={percent === null ? 'indeterminate' : 'determinate'} value={percent ?? 0} />
          <Box>
            <Button size="small" onClick={() => openPanel(null)}>
              Open the export
            </Button>
          </Box>
        </Stack>
      ) : (
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography sx={{ overflowWrap: 'anywhere' }}>{current.fileName}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {current.quality} · {formatBytes(current.sizeBytes)} · exported by{' '}
              {current.startedByYou ? 'you' : current.startedBy}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Started {formatUtc(current.startedAt)}
              {current.finishedAt ? `, finished ${formatUtc(current.finishedAt)}` : ''}
              {took ? `, took ${took}` : ''}
            </Typography>
          </Box>
          {current.partial ? <Chip size="small" color="warning" label="Part of the recording" /> : null}
          <SaveFileButton current={current} />
        </Stack>
      )}
      <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1.5 }}>
        Kept on the server until the next export starts, so saving it again reads nothing from Swarm.
      </Typography>
    </Paper>
  );
}
