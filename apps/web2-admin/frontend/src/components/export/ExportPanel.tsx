import {
  EXPORT_ACTIVE_STATES,
  exportFilePath,
  type ExportAction,
  type ExportOptionsResponse,
  type ExportSummary,
} from '@streaming-monorepo/web2-admin-common';
import DownloadIcon from '@mui/icons-material/Download';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { fetchExportOptions } from '../../api';
import { errorMessage } from '../../errors';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSnackbar } from '../Snackbar';
import {
  actionLabel,
  formatBytes,
  formatLength,
  formatUtc,
  needsDecision,
  percentRead,
  statusLine,
} from './exportText';
import { useExport } from './ExportProvider';

export const CANCEL_EXPORT_PROMPT =
  'Everything read from Swarm so far is deleted, and another export would start again from the beginning.';

export const CLEAR_EXPORT_PROMPT =
  'The file is deleted from the server for everyone, and exporting the recording again reads it from Swarm.';

/** Save file: the finished MP4, saved by the browser under the name the API gives it. */
export function SaveFileButton({
  current,
  variant = 'contained',
}: {
  current: ExportSummary;
  variant?: 'contained' | 'text';
}) {
  return (
    <Button
      variant={variant}
      size={variant === 'text' ? 'small' : 'medium'}
      startIcon={<DownloadIcon />}
      component="a"
      href={exportFilePath(current.id)}
      download={current.fileName ?? true}
      onClick={(event) => event.stopPropagation()}
    >
      Save file
    </Button>
  );
}

/** Clear: once confirmed, deletes the kept file from the server for everyone, as the panel's Clear does. */
export function ClearFileButton() {
  const { act } = useExport();
  const snackbar = useSnackbar();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const clear = async () => {
    setBusy(true);
    try {
      await act('clear');
      setConfirm(false);
    } catch (error) {
      snackbar.error(errorMessage(error, 'The file could not be cleared.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button color="error" disabled={busy} onClick={() => setConfirm(true)}>
        Clear
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Clear the kept file?"
        message={CLEAR_EXPORT_PROMPT}
        confirmText="Clear"
        cancelText="Keep it"
        busy={busy}
        onConfirm={() => void clear()}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

/**
 * The Download panel, one for the whole console. Opened for a stream from its page, it offers the qualities to choose
 * from; opened from the widget, or once an export started, it follows the export on the server, whichever stream that
 * is, with the actions it allows now.
 */
export function ExportPanel() {
  const { current, panel, closePanel, start, act } = useExport();
  const snackbar = useSnackbar();
  const [view, setView] = useState<'choose' | 'follow'>('follow');
  const [options, setOptions] = useState<ExportOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const active = current !== null && EXPORT_ACTIVE_STATES.includes(current.state);
  // Read when the panel opens: only an opening decides the view, and an export that starts meanwhile is followed.
  const activeNow = useRef(active);
  activeNow.current = active;

  useEffect(() => {
    if (panel.open) setView(panel.streamId !== null && !activeNow.current ? 'choose' : 'follow');
  }, [panel.open, panel.streamId]);

  useEffect(() => {
    if (panel.open && active) setView('follow');
  }, [panel.open, active]);

  useEffect(() => {
    if (!panel.open || view !== 'choose' || panel.streamId === null) return;
    let stale = false;
    setOptions(null);
    setLoadError(null);
    fetchExportOptions(panel.streamId).then(
      (answer) => {
        if (stale) return;
        setOptions(answer);
        setChoice(answer.qualities.find((quality) => quality.unavailable === null)?.rendition ?? '');
      },
      (error: unknown) => {
        if (!stale) setLoadError(errorMessage(error, 'The qualities of this recording could not be read.'));
      },
    );
    return () => {
      stale = true;
    };
  }, [panel.open, panel.streamId, view]);

  const run = async (work: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      snackbar.error(errorMessage(error, failure));
    } finally {
      setBusy(false);
    }
  };

  const startNow = () =>
    run(async () => {
      await start(panel.streamId!, choice);
      setView('follow');
    }, 'The export could not start.');

  const doAction = (action: ExportAction) => run(() => act(action), 'The export did not take that.');

  const keptHere =
    current?.state === 'done' && current.streamId === panel.streamId && current.rendition === choice ? current : null;
  const replacing = current?.state === 'done' && !keptHere ? current : null;

  return (
    <>
      <Dialog open={panel.open} onClose={closePanel} maxWidth="sm" fullWidth aria-labelledby="export-panel-title">
        {view === 'choose' ? (
          <>
            <DialogTitle id="export-panel-title">
              Download {options ? `“${options.title}”` : 'the recording'}
            </DialogTitle>
            <DialogContent>
              {loadError ? <Alert severity="error">{loadError}</Alert> : null}
              {!options && !loadError ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                  <CircularProgress aria-label="reading the qualities" />
                </Box>
              ) : null}
              {options ? (
                <Stack spacing={2}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {options.date ? `${options.date}, ` : ''}
                    {formatLength(options.durationSeconds)}. The admin reads the quality you choose from Swarm, joins it
                    into an MP4 on its server, and keeps it there, so anyone can save it again without another read. One
                    export runs at a time.
                  </Typography>
                  {options.refusal ? <Alert severity="warning">{options.refusal.message}</Alert> : null}
                  <RadioGroup aria-label="quality" value={choice} onChange={(event) => setChoice(event.target.value)}>
                    {options.qualities.map((quality) => (
                      <FormControlLabel
                        key={quality.rendition}
                        value={quality.rendition}
                        disabled={quality.unavailable !== null}
                        control={<Radio />}
                        label={
                          <Box>
                            <Typography>
                              {quality.label}
                              {quality.width && quality.height ? ` · ${quality.width}×${quality.height}` : ''}
                            </Typography>
                            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                              {quality.unavailable ??
                                (quality.estimatedBytes !== null
                                  ? `About ${formatBytes(quality.estimatedBytes)}`
                                  : 'Its size is known once it is read')}
                            </Typography>
                          </Box>
                        }
                      />
                    ))}
                  </RadioGroup>
                  {keptHere ? (
                    <Alert severity="success">
                      This quality is on the server already: {keptHere.fileName}, {formatBytes(keptHere.sizeBytes)}.
                      Saving it reads nothing from Swarm. To export it again, clear it first.
                    </Alert>
                  ) : null}
                  {replacing ? (
                    <Alert severity="info">Starting replaces the file kept on the server: {replacing.fileName}.</Alert>
                  ) : null}
                </Stack>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button onClick={closePanel}>Close</Button>
              {keptHere?.actions.includes('clear') ? (
                <Button color="error" disabled={busy} onClick={() => setConfirmClear(true)}>
                  Clear
                </Button>
              ) : null}
              {keptHere ? (
                <SaveFileButton current={keptHere} />
              ) : (
                <Button
                  variant="contained"
                  disabled={busy || !options || options.refusal !== null || choice === ''}
                  onClick={() => void startNow()}
                >
                  {busy ? 'Starting…' : 'Start export'}
                </Button>
              )}
            </DialogActions>
          </>
        ) : (
          <>
            <DialogTitle id="export-panel-title">{current ? `“${current.streamTitle}”` : 'Download'}</DialogTitle>
            <DialogContent>
              {current ? (
                <Stack spacing={2}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {current.quality} · started by {current.startedByYou ? 'you' : current.startedBy} at{' '}
                    {formatUtc(current.startedAt)}
                  </Typography>
                  {panel.streamId !== null && panel.streamId !== current.streamId && active ? (
                    <Alert severity="info">
                      One export runs at a time. This one has to finish, or be cancelled, before another can start.
                    </Alert>
                  ) : null}
                  {current.state === 'paused' ? (
                    <Alert severity={needsDecision(current) ? 'warning' : 'info'}>{statusLine(current)}</Alert>
                  ) : (
                    <Typography>{statusLine(current)}</Typography>
                  )}
                  {current.state !== 'done' ? (
                    <LinearProgress
                      aria-label="export progress"
                      variant={percentRead(current) === null ? 'indeterminate' : 'determinate'}
                      value={percentRead(current) ?? 0}
                    />
                  ) : null}
                  {current.state === 'paused' || current.state === 'waiting' ? (
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {current.segmentsRead} of {current.segmentsTotal ?? '?'} segments read,{' '}
                      {formatBytes(current.bytesRead)}.
                    </Typography>
                  ) : null}
                  {current.state === 'done' && current.partial ? (
                    <Alert severity="warning">
                      Saved from part of the recording: where a stretch is missing, the file cuts to the next one.
                    </Alert>
                  ) : null}
                </Stack>
              ) : (
                <Typography>No export is on the server.</Typography>
              )}
            </DialogContent>
            <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
              {current?.actions
                .filter((action) => action !== 'cancel' && action !== 'dismiss' && action !== 'clear')
                .map((action) => (
                  <Button key={action} disabled={busy} onClick={() => void doAction(action)}>
                    {actionLabel(action, current)}
                  </Button>
                ))}
              {current?.actions.includes('cancel') ? (
                <Button color="error" disabled={busy} onClick={() => setConfirmCancel(true)}>
                  Cancel export
                </Button>
              ) : null}
              {current?.actions.includes('clear') ? (
                <Button color="error" disabled={busy} onClick={() => setConfirmClear(true)}>
                  Clear
                </Button>
              ) : null}
              {current?.state === 'done' ? <SaveFileButton current={current} /> : null}
              <Button onClick={closePanel}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel the export?"
        message={CANCEL_EXPORT_PROMPT}
        confirmText="Cancel export"
        cancelText="Keep it"
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await act('cancel');
            setConfirmCancel(false);
          }, 'The export could not be cancelled.')
        }
        onCancel={() => setConfirmCancel(false)}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear the kept file?"
        message={CLEAR_EXPORT_PROMPT}
        confirmText="Clear"
        cancelText="Keep it"
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await act('clear');
            setConfirmClear(false);
          }, 'The file could not be cleared.')
        }
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
