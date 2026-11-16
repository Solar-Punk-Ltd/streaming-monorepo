import {
  archiveStampFits,
  isArchived,
  type ArchiveBuyChoice,
  type ArchiveJobItem,
  type ArchiveJobSummary,
  type ArchiveOptionsResponse,
  type ArchiveQuality,
  type ArchiveStamp,
} from '@streaming-monorepo/web2-admin-common';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { fetchArchiveOptions } from '../../api';
import { errorMessage } from '../../errors';
import { formatTimeLeft, shortHex } from '../../format';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSnackbar } from '../Snackbar';
import { formatUtc } from '../export/exportText';
import { dayCount } from '../funding/stamps';
import {
  archiveActionLabel,
  archiveItemLine,
  archiveItemPercent,
  archiveMoving,
  archiveNeedsDecision,
  archivePercent,
  archiveQualities,
  archiveStatusLine,
  archiveTargetText,
  estimateLine,
  estimateOf,
  formatChunks,
  formatCount,
  formatSeconds,
  formatXbzz,
  formatXbzzRange,
  QUALITY_STATE_COLOR,
  qualityStateText,
} from './archiveJobText';
import { useArchive } from './ArchiveProvider';
import { BuyStampDialog } from './BuyStampDialog';

export const CANCEL_ARCHIVE_PROMPT =
  'Chunks already copied stay on Swarm under the archive stamp, and their qualities show as "Archive incomplete". ' +
  'Archiving them again posts every chunk again, and what is on the stamp already takes no more room.';

/** Said beside "Buy a new archive stamp" when the price or the paying wallet could not be read. */
export const NO_BUY_TEXT = "A new stamp cannot be priced now: the price or the catalogue node's wallet was not read.";

/** Said beside "Buy a new archive stamp" when one can be bought. */
export const BUY_NEW_TEXT = 'Sized to the recording once it is measured, and bought only once you confirm its cost.';

/** The value of the "Buy a new archive stamp" choice, which no batch id can be. */
const BUY_NEW = 'buy-new';

function stampName(stamp: ArchiveStamp): string {
  return stamp.label ?? shortHex(stamp.batchId);
}

/** Whether a stamp holds `chunks` more; with no estimate, every writable stamp may, and the API checks. */
function stampFits(stamp: ArchiveStamp, chunks: number | null): boolean {
  return chunks === null ? stamp.writable : archiveStampFits(stamp, chunks);
}

/** `Depth 22, room for 1,200,000 chunks, 200 days left`, and why it cannot take the selection. */
function stampLine(stamp: ArchiveStamp, chunks: number | null): string {
  const room = stamp.roomChunks === null ? 'its room was not read' : `room for ${formatChunks(stamp.roomChunks)}`;
  const soon = stamp.expiresSoon ? ', expires soon' : '';
  const short =
    chunks !== null && !stampFits(stamp, chunks) ? `. Not enough room for ${formatChunks(chunks)} and a margin` : '';
  return `Depth ${stamp.depth}, ${room}, ${formatTimeLeft(stamp.ttlSeconds)} left${soon}${short}`;
}

function offered(quality: ArchiveQuality): boolean {
  return quality.unavailable === null;
}

/** The qualities ticked as the panel opens: those it was opened with, or the best one not archived yet. */
function initialTicks(options: ArchiveOptionsResponse, preselect: readonly string[]): string[] {
  const open = options.qualities.filter(offered);
  if (preselect.length > 0) return open.filter((q) => preselect.includes(q.rendition)).map((q) => q.rendition);
  const first = open.find((q) => !isArchived(q.state));
  return first ? [first.rendition] : [];
}

/**
 * Whether the chequebook can pay less than the high end of an estimate: a warning before a start, never a refusal.
 * Nothing is said when either was not read.
 */
function chequebookShort(availablePlur: string | null, highPlur: string | null): boolean {
  if (availablePlur === null || highPlur === null) return false;
  if (!/^\d+$/.test(availablePlur) || !/^\d+$/.test(highPlur)) return false;
  return BigInt(availablePlur) < BigInt(highPlur);
}

function selectedOf(options: ArchiveOptionsResponse, ticked: readonly string[]): ArchiveQuality[] {
  return options.qualities.filter((q) => ticked.includes(q.rendition));
}

/** The first stamp that takes the selection, or a new one when none does and one can be bought. */
function defaultTarget(options: ArchiveOptionsResponse, chunks: number | null): string {
  const fit = options.stamps.find((stamp) => stampFits(stamp, chunks));
  if (fit) return fit.batchId;
  return options.buy !== null ? BUY_NEW : '';
}

/** What is left to copy, which another stamp must hold: the proposal's chunks, or those of the unfinished qualities. */
function chunksLeft(job: ArchiveJobSummary): number | null {
  if (job.proposal) return job.proposal.chunkCount;
  let total = 0;
  for (const item of job.items) {
    if (item.state === 'done') continue;
    if (item.chunksTotal === null) return null;
    total += item.chunksTotal;
  }
  return total;
}

function isPlainAction(action: string): action is 'pause' | 'resume' | 'wait' {
  return action === 'pause' || action === 'resume' || action === 'wait';
}

/** One quality of the running archive: where it stands, with its own bar while it copies or verifies. */
function ItemRow({ item }: { item: ArchiveJobItem }) {
  const done = archiveItemPercent(item);
  const moving = item.state === 'copying' || item.state === 'verifying';
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
        <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 56 }}>
          {item.label}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {archiveItemLine(item)}
        </Typography>
      </Stack>
      {moving ? (
        <LinearProgress
          aria-label={`${item.label} progress`}
          sx={{ mt: 0.5 }}
          variant={done === null ? 'indeterminate' : 'determinate'}
          value={done ?? 0}
        />
      ) : null}
    </Box>
  );
}

/**
 * Another archive stamp for the running archive, after a stamp ran out of room or in place of a new one: the stamps
 * that can be written, read again as it opens, the one in use left out.
 */
function UseStampDialog({
  job,
  open,
  busy,
  onUse,
  onClose,
}: {
  job: ArchiveJobSummary;
  open: boolean;
  busy: boolean;
  onUse: (batchId: string) => void;
  onClose: () => void;
}) {
  const [stamps, setStamps] = useState<ArchiveStamp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const need = chunksLeft(job);
  const inUse = job.target.kind === 'stamp' ? job.target.batchId : null;

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setStamps(null);
    setError(null);
    setChoice('');
    fetchArchiveOptions(job.streamId).then(
      (answer) => {
        if (stale) return;
        const others = answer.stamps.filter((stamp) => stamp.batchId !== inUse);
        setStamps(others);
        setChoice(others.find((stamp) => stampFits(stamp, need))?.batchId ?? '');
      },
      (failure: unknown) => {
        if (!stale) setError(errorMessage(failure, 'The archive stamps could not be read.'));
      },
    );
    return () => {
      stale = true;
    };
  }, [open, job.streamId, inUse, need]);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="use-stamp-title">
      <DialogTitle id="use-stamp-title">Use another archive stamp</DialogTitle>
      <DialogContent>
        {error ? <Alert severity="error">{error}</Alert> : null}
        {!stamps && !error ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress aria-label="reading the archive stamps" />
          </Box>
        ) : null}
        {stamps && stamps.length === 0 ? (
          <Typography>
            No other archive stamp can be written. Buy a new one, or dilute this one and try again.
          </Typography>
        ) : null}
        {stamps && stamps.length > 0 ? (
          <RadioGroup aria-label="archive stamp" value={choice} onChange={(event) => setChoice(event.target.value)}>
            {stamps.map((stamp) => (
              <FormControlLabel
                key={stamp.batchId}
                value={stamp.batchId}
                disabled={!stampFits(stamp, need)}
                control={<Radio />}
                label={
                  <Box>
                    <Typography>{stampName(stamp)}</Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {stampLine(stamp, need)}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" disabled={busy || choice === ''} onClick={() => onUse(choice)}>
          Use this stamp
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** How fast the copy goes and how long is left, while it copies. */
function RateLine({ job }: { job: ArchiveJobSummary }) {
  if (job.state !== 'copying' && job.state !== 'verifying') return null;
  const left = formatSeconds(job.secondsLeft);
  const rate = job.chunksPerSecond !== null ? `${formatCount(Math.round(job.chunksPerSecond))} chunks a second` : null;
  const line = [rate, left ? `about ${left} left` : null].filter((part): part is string => part !== null).join(', ');
  if (!line) return null;
  return (
    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
      {line.charAt(0).toUpperCase() + line.slice(1)}.
    </Typography>
  );
}

/**
 * What the copy costs the catalogue node's chequebook: the estimate and what it can pay while it runs, with a warning
 * when it holds less, and what it went down by once done.
 */
function CostLine({ job }: { job: ArchiveJobSummary }) {
  if (job.state === 'done') {
    return job.bzzSpentPlur !== null ? (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        The catalogue node's chequebook went down by about {formatXbzz(job.bzzSpentPlur)}. The catalogue's own writes
        share it.
      </Typography>
    ) : null;
  }
  const range = formatXbzzRange(job.bzzEstimateLowPlur, job.bzzEstimateHighPlur);
  if (!range) return null;
  const available = job.chequebookAvailablePlur;
  const high = job.bzzEstimateHighPlur;
  const short =
    available !== null && high !== null && /^\d+$/.test(available) && /^\d+$/.test(high)
      ? BigInt(available) < BigInt(high)
      : false;
  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Expected to cost the catalogue node's chequebook {range}.
        {available !== null ? ` It can pay ${formatXbzz(available)} now.` : ''}
      </Typography>
      {short ? (
        <Alert severity="warning">
          The chequebook holds less than the copy may cost. Fund it on the Funding page's Chequebooks tab: under its
          floor the archive pauses.
        </Alert>
      ) : null}
    </Stack>
  );
}

/**
 * The archive panel, one for the whole console. Opened for a stream, from its page, the Archive page or a finished
 * export, it offers the stream's qualities, each with its estimate, and where to copy them: an archive stamp that has
 * room, or a new one, sized once the recording is measured. Opened from the widget, or once an archive started, it
 * follows the archive on the server, whichever stream that is, with what it allows now: its pauses with their
 * choices, and the confirm of the new stamp it waits to buy.
 */
export function ArchivePanel() {
  const { current, panel, closePanel, start, act, confirmPurchase } = useArchive();
  const snackbar = useSnackbar();
  const [view, setView] = useState<'choose' | 'follow'>('follow');
  const [options, setOptions] = useState<ArchiveOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pickStamp, setPickStamp] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyRefusal, setBuyRefusal] = useState<string | null>(null);
  const unfinished = current !== null && current.state !== 'done';
  // Read when the panel opens: only an opening decides the view, and an archive that starts meanwhile is followed.
  const unfinishedNow = useRef(unfinished);
  unfinishedNow.current = unfinished;
  const buyOffered = useRef<string | null>(null);

  useEffect(() => {
    if (panel.open) setView(panel.streamId !== null && !unfinishedNow.current ? 'choose' : 'follow');
  }, [panel.open, panel.streamId]);

  useEffect(() => {
    if (panel.open && unfinished) setView('follow');
  }, [panel.open, unfinished]);

  useEffect(() => {
    if (!panel.open || view !== 'choose' || panel.streamId === null) return;
    let stale = false;
    setOptions(null);
    setLoadError(null);
    fetchArchiveOptions(panel.streamId).then(
      (answer) => {
        if (stale) return;
        const picked = initialTicks(answer, panel.preselect);
        setOptions(answer);
        setTicked(picked);
        setTarget(defaultTarget(answer, estimateOf(selectedOf(answer, picked)).chunks));
      },
      (error: unknown) => {
        if (!stale) setLoadError(errorMessage(error, 'The qualities of this recording could not be read.'));
      },
    );
    return () => {
      stale = true;
    };
  }, [panel.open, panel.streamId, panel.preselect, view]);

  // The buy dialog comes to front with the panel for the user who started the archive, once each time it waits.
  const awaiting = current?.state === 'awaiting_purchase' ? current : null;
  const awaitingId = awaiting?.id ?? null;
  const awaitingMine = awaiting?.startedByYou ?? false;
  useEffect(() => {
    if (awaitingId === null) {
      buyOffered.current = null;
      setBuyOpen(false);
      setBuyRefusal(null);
      return;
    }
    if (panel.open && awaitingMine && buyOffered.current !== awaitingId) {
      buyOffered.current = awaitingId;
      setBuyOpen(true);
    }
  }, [awaitingId, awaitingMine, panel.open]);

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

  const selected = options ? selectedOf(options, ticked) : [];
  const estimate = estimateOf(selected);

  const toggle = (rendition: string) => {
    if (!options) return;
    const next = ticked.includes(rendition) ? ticked.filter((r) => r !== rendition) : [...ticked, rendition];
    setTicked(next);
    const chunks = estimateOf(selectedOf(options, next)).chunks;
    const stamp = options.stamps.find((candidate) => candidate.batchId === target);
    if (target === '' || (stamp && !stampFits(stamp, chunks))) setTarget(defaultTarget(options, chunks));
  };

  const startNow = () =>
    run(async () => {
      if (!options || panel.streamId === null) return;
      await start(panel.streamId, {
        renditions: selected.map((q) => q.rendition),
        target: target === BUY_NEW ? { buyNew: true } : { batchId: target },
      });
      setView('follow');
    }, 'The archive could not start.');

  const confirm = async (choice: ArchiveBuyChoice) => {
    setBuying(true);
    setBuyRefusal(null);
    try {
      await confirmPurchase(choice);
      setBuyOpen(false);
    } catch (error) {
      setBuyRefusal(errorMessage(error, 'The stamp could not be bought.'));
    } finally {
      setBuying(false);
    }
  };

  const buyNew = () =>
    run(async () => {
      await act({ action: 'buy_new' });
      // Whoever asked for the new stamp confirms it: the dialog opens as soon as the archive proposes it.
      buyOffered.current = null;
      setBuyOpen(true);
    }, 'The archive did not take that.');

  const useStamp = (batchId: string) =>
    run(async () => {
      await act({ action: 'use_stamp', batchId });
      setPickStamp(false);
    }, 'The archive did not take that stamp.');

  const proposal = awaiting?.proposal ?? null;

  return (
    <>
      <Dialog open={panel.open} onClose={closePanel} maxWidth="sm" fullWidth aria-labelledby="archive-panel-title">
        {view === 'choose' ? (
          <>
            <DialogTitle id="archive-panel-title">
              Archive {options ? `“${options.title}”` : 'the recording'}
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
                    {options.date ? `${options.date}. ` : ''}
                    The admin copies the qualities you pick onto an archive stamp on the catalogue node, byte for byte,
                    so the recording outlives the stage's batches and plays as before. The catalogue node pays its peers
                    for the copy from its chequebook. One job runs at a time, an export or an archive.
                  </Typography>
                  {options.refusal ? <Alert severity="warning">{options.refusal.message}</Alert> : null}
                  <FormGroup aria-label="qualities">
                    {options.qualities.map((quality) => (
                      <FormControlLabel
                        key={quality.rendition}
                        disabled={!offered(quality)}
                        control={
                          <Checkbox
                            checked={ticked.includes(quality.rendition)}
                            onChange={() => toggle(quality.rendition)}
                          />
                        }
                        label={
                          <Box>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                              <Typography>
                                {quality.label}
                                {quality.width && quality.height ? ` · ${quality.width}×${quality.height}` : ''}
                              </Typography>
                              {quality.state !== 'none' ? (
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color={QUALITY_STATE_COLOR[quality.state]}
                                  label={qualityStateText(quality.state)}
                                />
                              ) : null}
                            </Stack>
                            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                              {quality.unavailable ?? estimateLine(estimateOf([quality]))}
                            </Typography>
                          </Box>
                        }
                      />
                    ))}
                  </FormGroup>
                  {selected.length > 1 ? (
                    <Typography variant="body2">In all: {estimateLine(estimate)}.</Typography>
                  ) : null}
                  {chequebookShort(options.chequebookAvailablePlur, estimate.bzzHighPlur) ? (
                    <Alert severity="warning">
                      The catalogue node's chequebook can pay {formatXbzz(options.chequebookAvailablePlur!)} now, less
                      than this archive may cost. It may run out while the copy runs, and the archive would then pause
                      for funds. Fund it on the Funding page's Chequebooks tab.
                    </Alert>
                  ) : null}
                  <Box>
                    <Typography variant="subtitle2" component="h3" gutterBottom>
                      Where it is copied to
                    </Typography>
                    <RadioGroup
                      aria-label="archive stamp"
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                    >
                      {options.stamps.map((stamp) => {
                        const fits = stampFits(stamp, estimate.chunks);
                        return (
                          <FormControlLabel
                            key={stamp.batchId}
                            value={stamp.batchId}
                            disabled={!fits}
                            control={<Radio />}
                            label={
                              <Box>
                                <Typography>{stampName(stamp)}</Typography>
                                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                  {stampLine(stamp, estimate.chunks)}
                                </Typography>
                              </Box>
                            }
                          />
                        );
                      })}
                      <FormControlLabel
                        value={BUY_NEW}
                        disabled={options.buy === null}
                        control={<Radio />}
                        label={
                          <Box>
                            <Typography>Buy a new archive stamp</Typography>
                            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                              {options.buy === null ? NO_BUY_TEXT : BUY_NEW_TEXT}
                            </Typography>
                          </Box>
                        }
                      />
                    </RadioGroup>
                  </Box>
                </Stack>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button onClick={closePanel}>Close</Button>
              <Button
                variant="contained"
                disabled={busy || !options || options.refusal !== null || selected.length === 0 || target === ''}
                onClick={() => void startNow()}
              >
                {busy ? 'Starting…' : 'Start archive'}
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <DialogTitle id="archive-panel-title">
              {current ? `Archive of “${current.streamTitle}”` : 'Archive'}
            </DialogTitle>
            <DialogContent>
              {current ? (
                <Stack spacing={2}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {archiveQualities(current)} onto {archiveTargetText(current)} · started by{' '}
                    {current.startedByYou ? 'you' : current.startedBy} at {formatUtc(current.startedAt)}
                  </Typography>
                  {panel.streamId !== null && panel.streamId !== current.streamId && unfinished ? (
                    <Alert severity="info">
                      One archive exists at a time. This one has to finish, or be cancelled, before another can start.
                    </Alert>
                  ) : null}
                  {current.state === 'paused' ? (
                    <Alert severity={archiveNeedsDecision(current) ? 'warning' : 'info'}>
                      {archiveStatusLine(current)}
                    </Alert>
                  ) : (
                    <Typography>{archiveStatusLine(current)}</Typography>
                  )}
                  {archiveMoving(current) ? (
                    <LinearProgress
                      aria-label="archive progress"
                      variant={archivePercent(current) === null ? 'indeterminate' : 'determinate'}
                      value={archivePercent(current) ?? 0}
                    />
                  ) : null}
                  <RateLine job={current} />
                  {current.target.kind === 'purchase' && current.target.purchase ? (
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      The new stamp: depth {current.target.purchase.depth} for {dayCount(current.target.purchase.days)},{' '}
                      {formatXbzz(current.target.purchase.costPlur)}
                      {current.target.purchase.label ? `, “${current.target.purchase.label}”` : ''}.
                      {current.target.purchase.error ? ` ${current.target.purchase.error}` : ''}
                    </Typography>
                  ) : null}
                  {proposal ? (
                    <Stack spacing={1.5}>
                      <Typography variant="body2">
                        The recording measured {formatChunks(proposal.chunkCount)}.{' '}
                        {proposal.depth !== null && proposal.costPlur !== null
                          ? `The smallest archive stamp that holds them with room to spare is depth ${proposal.depth}: ${formatXbzz(proposal.costPlur)} for ${dayCount(proposal.days)}, paid from the catalogue node's wallet.`
                          : 'No archive stamp can be priced for them now.'}
                      </Typography>
                      {proposal.shortfallPlur !== null ? (
                        <Alert severity="warning">
                          The catalogue node's wallet is {formatXbzz(proposal.shortfallPlur)} short of that. Send it
                          xBZZ on the Funding page's Balance tab.
                        </Alert>
                      ) : null}
                      {buyRefusal && !buyOpen ? <Alert severity="error">{buyRefusal}</Alert> : null}
                      <Box>
                        <Button variant="contained" onClick={() => setBuyOpen(true)}>
                          Choose the stamp
                        </Button>
                      </Box>
                    </Stack>
                  ) : null}
                  <CostLine job={current} />
                  {current.items.length > 0 ? (
                    <Stack spacing={1} aria-label="qualities">
                      {current.items.map((item) => (
                        <ItemRow key={item.rendition} item={item} />
                      ))}
                    </Stack>
                  ) : null}
                </Stack>
              ) : (
                <Typography>No archive is on the server.</Typography>
              )}
            </DialogContent>
            <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
              {current?.actions.filter(isPlainAction).map((action) => (
                <Button
                  key={action}
                  disabled={busy}
                  onClick={() => void run(() => act({ action }), 'The archive did not take that.')}
                >
                  {archiveActionLabel(action, current)}
                </Button>
              ))}
              {current?.actions.includes('use_stamp') ? (
                <Button disabled={busy} onClick={() => setPickStamp(true)}>
                  {archiveActionLabel('use_stamp', current)}
                </Button>
              ) : null}
              {current?.actions.includes('buy_new') ? (
                <Button disabled={busy} onClick={() => void buyNew()}>
                  {archiveActionLabel('buy_new', current)}
                </Button>
              ) : null}
              {current?.actions.includes('cancel') ? (
                <Button color="error" disabled={busy} onClick={() => setConfirmCancel(true)}>
                  {archiveActionLabel('cancel', current)}
                </Button>
              ) : null}
              <Button onClick={closePanel}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
      {current ? (
        <UseStampDialog
          job={current}
          open={pickStamp}
          busy={busy}
          onUse={(batchId) => void useStamp(batchId)}
          onClose={() => setPickStamp(false)}
        />
      ) : null}
      {proposal ? (
        <BuyStampDialog
          open={buyOpen}
          terms={proposal.terms}
          chunkCount={proposal.chunkCount}
          busy={buying}
          refusal={buyRefusal}
          onConfirm={(choice) => void confirm(choice)}
          onClose={() => setBuyOpen(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel the archive?"
        message={CANCEL_ARCHIVE_PROMPT}
        confirmText="Cancel archive"
        cancelText="Keep it"
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await act({ action: 'cancel' });
            setConfirmCancel(false);
          }, 'The archive could not be cancelled.')
        }
        onCancel={() => setConfirmCancel(false)}
      />
    </>
  );
}
