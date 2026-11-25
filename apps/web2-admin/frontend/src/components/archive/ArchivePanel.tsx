import {
  archivedOnStamp,
  archivedOnStampAlready,
  archiveStampFits,
  isArchived,
  type ArchiveBuyChoice,
  type ArchiveCopy,
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
  IconButton,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { fetchArchiveOptions } from '../../api';
import { errorMessage } from '../../errors';
import { formatTimeLeft, shortHex } from '../../format';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSnackbar } from '../Snackbar';
import { formatBytes, formatUtc, isPlainClick, STREAM_PAGE_LINK_LABEL } from '../export/exportText';
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
import type { ArchivePanelMode } from './archiveSeams';
import { BuyStampDialog } from './BuyStampDialog';

export const CANCEL_ARCHIVE_PROMPT =
  'Chunks already copied stay on Swarm under the archive stamp, and their qualities show as "Archive incomplete". ' +
  'Archiving them again posts every chunk again, and what is on the stamp already takes no more room.';

/** Said beside "Buy a new archive stamp" when the price or the paying wallet could not be read. */
export const NO_BUY_TEXT = "A new stamp cannot be priced now: the price or the catalogue node's wallet was not read.";

/** Said beside "Buy a new archive stamp" when one can be bought. */
export const BUY_NEW_TEXT = 'Sized to the recording once it is measured, and bought only once you confirm its cost.';

/** What the panel says first, for a first archive. */
const ARCHIVE_INTRO =
  'The admin copies the qualities you pick onto an archive stamp on the catalogue node, byte for byte, so the ' +
  "recording outlives the stage's batches and plays as before. The catalogue node pays its peers for the copy from " +
  'its chequebook. One job runs at a time, an export or an archive.';

/** What the panel says first, for a further copy. */
const COPY_INTRO =
  'The admin copies the archived qualities you pick onto another archive stamp on the catalogue node, byte for ' +
  'byte, as their first archive did. Ticking every quality moves the whole recording onto that stamp. The ' +
  'catalogue node pays its peers for the copy from its chequebook. One job runs at a time, an export or an archive.';

/**
 * Said for a first archive when every quality that finished recording is archived, so none can be ticked. The API
 * refuses nothing then, since a further copy of them can start, from the Archive page.
 */
export const ALL_ARCHIVED_TEXT =
  'Every quality of this recording is archived. To copy it onto another stamp, use the Archive page.';

/** Said for a further copy when no quality of the recording is archived now. */
export const NOTHING_TO_COPY_TEXT =
  'No quality of this recording is archived now, so there is nothing to copy onto another stamp.';

/** The value of the "Buy a new archive stamp" choice, which no batch id can be. */
const BUY_NEW = 'buy-new';

function stampName(stamp: ArchiveStamp): string {
  return stamp.label ?? shortHex(stamp.batchId);
}

/** A stamp in a sentence: its label in quotes, or "the stamp" and its short id. */
function stampWords(batchId: string, label: string | null): string {
  return label ? `“${label}”` : `the stamp ${shortHex(batchId)}`;
}

/** Names in a sentence: `“Talks”`, `“Talks” and “Spring”`, `“Talks”, “Spring” and “Autumn”`. */
function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Whether a stamp holds `chunks` more; with no estimate, every writable stamp may, and the API checks. */
function stampFits(stamp: ArchiveStamp, chunks: number | null): boolean {
  return chunks === null ? stamp.writable : archiveStampFits(stamp, chunks);
}

/** The first of the qualities with an archived copy on the stamp, or null. A further copy of it is refused there. */
function archivedHere(qualities: readonly ArchiveQuality[], batchId: string): ArchiveQuality | null {
  return qualities.find((quality) => archivedOnStamp(quality, batchId)) ?? null;
}

/** Whether a stamp takes the qualities: it has the room for them, and holds an archived copy of none of them. */
function stampTakes(stamp: ArchiveStamp, chunks: number | null, qualities: readonly ArchiveQuality[]): boolean {
  return stampFits(stamp, chunks) && archivedHere(qualities, stamp.batchId) === null;
}

/**
 * `Depth 22, room for 1,200,000 chunks, 200 days left`, and why it cannot take the selection: `archived`, a quality of
 * it that is archived on the stamp already, or too little room.
 */
function stampLine(stamp: ArchiveStamp, chunks: number | null, archived: ArchiveQuality | null = null): string {
  const room = stamp.roomChunks === null ? 'its room was not read' : `room for ${formatChunks(stamp.roomChunks)}`;
  const soon = stamp.expiresSoon ? ', expires soon' : '';
  let why = '';
  if (archived) why = `. ${archivedOnStampAlready(archived.label)}`;
  else if (chunks !== null && !stampFits(stamp, chunks)) {
    why = `. Not enough room for ${formatChunks(chunks)} and a margin`;
  }
  return `Depth ${stamp.depth}, ${room}, ${formatTimeLeft(stamp.ttlSeconds)} left${soon}${why}`;
}

/**
 * Whether a quality can be ticked: for a first archive, one whose first archive can start now; for a further copy, an
 * archived one, whatever `unavailable` says of a first archive.
 */
function offered(quality: ArchiveQuality, mode: ArchivePanelMode): boolean {
  return mode === 'copy' ? isArchived(quality.state) : quality.unavailable === null;
}

/**
 * The qualities the panel lists: for a first archive every one, an archived one shown too; for a further copy the
 * archived ones alone.
 */
function listedOf(options: ArchiveOptionsResponse, mode: ArchivePanelMode): ArchiveQuality[] {
  return mode === 'copy' ? options.qualities.filter((q) => isArchived(q.state)) : options.qualities;
}

/**
 * The qualities ticked as the panel opens: those it was opened with; otherwise, for a first archive, the best one not
 * archived yet, and for a further copy every archived one, which moves the whole recording.
 */
function initialTicks(options: ArchiveOptionsResponse, preselect: readonly string[], mode: ArchivePanelMode): string[] {
  const open = options.qualities.filter((q) => offered(q, mode));
  if (preselect.length > 0) return open.filter((q) => preselect.includes(q.rendition)).map((q) => q.rendition);
  if (mode === 'copy') return open.map((q) => q.rendition);
  const first = open.find((q) => !isArchived(q.state));
  return first ? [first.rendition] : [];
}

/**
 * The chunks the qualities take on a stamp: for a first archive their estimates; for a further copy what each one's
 * archived copy holds, as it was counted when that copy was made, or its estimate when that is not known. Null when
 * one of them is not known.
 */
function roomOf(qualities: readonly ArchiveQuality[], mode: ArchivePanelMode): number | null {
  if (mode === 'archive') return estimateOf(qualities).chunks;
  let total = 0;
  for (const quality of qualities) {
    const chunks = quality.chunks ?? quality.estimatedChunks;
    if (chunks === null) return null;
    total += chunks;
  }
  return total;
}

/**
 * Whether every quality that finished recording is archived, one at least, so a first archive has nothing to tick. The
 * API refuses nothing for it, since a further copy of them can start, from the Archive page.
 */
function everyQualityArchived(options: ArchiveOptionsResponse): boolean {
  return (
    options.qualities.some((quality) => isArchived(quality.state)) &&
    options.qualities.every((quality) => quality.unavailable !== null)
  );
}

/** The archived copies of the qualities, one for each stamp, in the order of the qualities and of their copies. */
function archivedCopiesOf(qualities: readonly ArchiveQuality[]): ArchiveCopy[] {
  const byStamp = new Map<string, ArchiveCopy>();
  for (const quality of qualities) {
    for (const copy of quality.copies) {
      if (isArchived(copy.state) && !byStamp.has(copy.batchId)) byStamp.set(copy.batchId, copy);
    }
  }
  return [...byStamp.values()];
}

/** Where an archived quality is, and what its copy holds: `On “Talks” and “Spring”: 2.2 GB, 540,000 chunks.` */
export function copiesLine(quality: ArchiveQuality): string {
  const stamps = archivedCopiesOf([quality]).map((copy) => stampWords(copy.batchId, copy.batchLabel));
  if (stamps.length === 0 && quality.batchId !== null) stamps.push(stampWords(quality.batchId, quality.batchLabel));
  const where = stamps.length > 0 ? `On ${listWords(stamps)}` : 'On an archive stamp';
  const size = [
    quality.bytes !== null ? formatBytes(quality.bytes) : null,
    quality.chunks !== null ? formatChunks(quality.chunks) : null,
  ].filter((part): part is string => part !== null);
  return `${where}${size.length > 0 ? `: ${size.join(', ')}` : ''}.`;
}

/**
 * What the panel says before a further copy starts: the room it takes on the stamp chosen, or on a new one; what its
 * bandwidth costs the catalogue node's chequebook, as a first copy's does; and that each copy the qualities have now
 * stays on its stamp until that stamp runs out. `target` is the stamp chosen, `'new'` for a new one, or null for none.
 */
export function furtherCopyLines(qualities: readonly ArchiveQuality[], target: ArchiveStamp | 'new' | null): string[] {
  const chunks = roomOf(qualities, 'copy');
  let where = '';
  if (target === 'new') where = ' on a new archive stamp, sized to it once the recording is measured';
  else if (target !== null) where = ` on ${stampWords(target.batchId, target.label)}`;
  const room =
    chunks === null
      ? 'The room the copy takes is known once the recording is measured.'
      : `The copy takes room for ${formatChunks(chunks)}${where}.`;
  const estimate = estimateOf(qualities);
  const range = formatXbzzRange(estimate.bzzLowPlur, estimate.bzzHighPlur);
  const bandwidth = range
    ? `Its bandwidth costs the catalogue node's chequebook ${range}, as a first copy's does.`
    : "Its bandwidth is paid from the catalogue node's chequebook, as a first copy's is.";
  const stays = archivedCopiesOf(qualities).map(
    (copy) => `The copy on ${stampWords(copy.batchId, copy.batchLabel)} stays until that stamp runs out.`,
  );
  return [room, bandwidth, ...stays];
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

/** The first stamp that takes the qualities ticked, or a new one when none does and one can be bought. */
function defaultTarget(
  options: ArchiveOptionsResponse,
  chunks: number | null,
  ticked: readonly ArchiveQuality[],
): string {
  const fit = options.stamps.find((stamp) => stampTakes(stamp, chunks, ticked));
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
 * that can be written, read again as it opens, the one in use left out, and one that holds an archived copy of a
 * quality the archive copies greyed out with the reason, as the API refuses it.
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
  // The qualities the archive copies, as the stream's options read them with their copies.
  const [copied, setCopied] = useState<ArchiveQuality[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const need = chunksLeft(job);
  const inUse = job.target.kind === 'stamp' ? job.target.batchId : null;
  // A key that stays the same while the archive's items do, read on every look at the archive.
  const renditions = job.items.map((item) => item.rendition).join(' ');

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setStamps(null);
    setCopied([]);
    setError(null);
    setChoice('');
    fetchArchiveOptions(job.streamId).then(
      (answer) => {
        if (stale) return;
        const others = answer.stamps.filter((stamp) => stamp.batchId !== inUse);
        const names = renditions.split(' ');
        const qualities = answer.qualities.filter((quality) => names.includes(quality.rendition));
        setStamps(others);
        setCopied(qualities);
        setChoice(others.find((stamp) => stampTakes(stamp, need, qualities))?.batchId ?? '');
      },
      (failure: unknown) => {
        if (!stale) setError(errorMessage(failure, 'The archive stamps could not be read.'));
      },
    );
    return () => {
      stale = true;
    };
  }, [open, job.streamId, inUse, need, renditions]);

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
            {stamps.map((stamp) => {
              const archived = archivedHere(copied, stamp.batchId);
              return (
                <FormControlLabel
                  key={stamp.batchId}
                  value={stamp.batchId}
                  disabled={!stampTakes(stamp, need, copied)}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography>{stampName(stamp)}</Typography>
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {stampLine(stamp, need, archived)}
                      </Typography>
                    </Box>
                  }
                />
              );
            })}
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
 * room, or a new one, sized once the recording is measured. Opened in `'copy'` mode, by the Archive page's "Copy onto
 * another stamp", it offers the stream's archived qualities for a further copy, every stamp that holds an archived
 * copy of a ticked one left out with the reason, and says before the start the room the copy takes, what its bandwidth
 * costs, and that each copy there is now stays until its stamp runs out. Opened from the widget, or once an archive
 * started, it follows the archive on the server, whichever stream that is, with what it allows now: its pauses with
 * their choices, and the confirm of the new stamp it waits to buy.
 */
export function ArchivePanel() {
  const { current, panel, closePanel, start, act, confirmPurchase } = useArchive();
  const mode = panel.mode;
  const snackbar = useSnackbar();
  const [view, setView] = useState<'choose' | 'follow'>('follow');
  const [options, setOptions] = useState<ArchiveOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pickStamp, setPickStamp] = useState(false);
  // The archive the buy dialog was opened for, null while it is closed. Its confirm names that archive, never the one
  // current at the click: another user may have cancelled it and started a new one meanwhile.
  const [buyFor, setBuyFor] = useState<string | null>(null);
  const buyOpen = buyFor !== null;
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
        const picked = selectedOf(answer, initialTicks(answer, panel.preselect, panel.mode));
        setOptions(answer);
        setTicked(picked.map((q) => q.rendition));
        setTarget(defaultTarget(answer, roomOf(picked, panel.mode), picked));
      },
      (error: unknown) => {
        if (!stale) setLoadError(errorMessage(error, 'The qualities of this recording could not be read.'));
      },
    );
    return () => {
      stale = true;
    };
  }, [panel.open, panel.streamId, panel.preselect, panel.mode, view]);

  // The buy dialog comes to front with the panel for the user who started the archive, once each time it waits.
  const awaiting = current?.state === 'awaiting_purchase' ? current : null;
  const awaitingId = awaiting?.id ?? null;
  const awaitingMine = awaiting?.startedByYou ?? false;
  useEffect(() => {
    if (awaitingId === null) {
      buyOffered.current = null;
      setBuyFor(null);
      setBuyRefusal(null);
      return;
    }
    if (panel.open && awaitingMine && buyOffered.current !== awaitingId) {
      buyOffered.current = awaitingId;
      setBuyFor(awaitingId);
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
  const room = roomOf(selected, mode);
  const chosen = options?.stamps.find((stamp) => stamp.batchId === target) ?? null;

  const toggle = (rendition: string) => {
    if (!options) return;
    const next = ticked.includes(rendition) ? ticked.filter((r) => r !== rendition) : [...ticked, rendition];
    setTicked(next);
    const picked = selectedOf(options, next);
    const chunks = roomOf(picked, mode);
    const stamp = options.stamps.find((candidate) => candidate.batchId === target);
    if (target === '' || (stamp && !stampTakes(stamp, chunks, picked))) {
      setTarget(defaultTarget(options, chunks, picked));
    }
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
    if (buyFor === null) return;
    setBuying(true);
    setBuyRefusal(null);
    try {
      await confirmPurchase(buyFor, choice);
      setBuyFor(null);
    } catch (error) {
      setBuyRefusal(errorMessage(error, 'The stamp could not be bought.'));
    } finally {
      setBuying(false);
    }
  };

  const buyNew = () =>
    run(async () => {
      const jobId = current?.id ?? null;
      await act({ action: 'buy_new' });
      // Whoever asked for the new stamp confirms it: the dialog opens as soon as the archive proposes it.
      buyOffered.current = null;
      setBuyFor(jobId);
    }, 'The archive did not take that.');

  const useStamp = (batchId: string) =>
    run(async () => {
      await act({ action: 'use_stamp', batchId });
      setPickStamp(false);
    }, 'The archive did not take that stamp.');

  const proposal = awaiting?.proposal ?? null;
  const recording = options ? `“${options.title}”` : 'the recording';
  const listed = options ? listedOf(options, mode) : [];
  const startText = mode === 'copy' ? 'Start copy' : 'Start archive';

  return (
    <>
      <Dialog open={panel.open} onClose={closePanel} maxWidth="sm" fullWidth aria-labelledby="archive-panel-title">
        {view === 'choose' ? (
          <>
            <DialogTitle id="archive-panel-title">
              {mode === 'copy' ? `Copy ${recording} onto another stamp` : `Archive ${recording}`}
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
                    {mode === 'copy' ? COPY_INTRO : ARCHIVE_INTRO}
                  </Typography>
                  {options.refusal ? <Alert severity="warning">{options.refusal.message}</Alert> : null}
                  {mode === 'archive' && options.refusal === null && everyQualityArchived(options) ? (
                    <Alert severity="info">{ALL_ARCHIVED_TEXT}</Alert>
                  ) : null}
                  {mode === 'copy' && listed.length === 0 ? (
                    <Alert severity="info">{NOTHING_TO_COPY_TEXT}</Alert>
                  ) : null}
                  <FormGroup aria-label="qualities">
                    {listed.map((quality) => (
                      <FormControlLabel
                        key={quality.rendition}
                        disabled={!offered(quality, mode)}
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
                              {mode === 'copy'
                                ? copiesLine(quality)
                                : (quality.unavailable ?? estimateLine(estimateOf([quality])))}
                            </Typography>
                          </Box>
                        }
                      />
                    ))}
                  </FormGroup>
                  {mode === 'archive' && selected.length > 1 ? (
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
                        const archived = archivedHere(selected, stamp.batchId);
                        return (
                          <FormControlLabel
                            key={stamp.batchId}
                            value={stamp.batchId}
                            disabled={!stampTakes(stamp, room, selected)}
                            control={<Radio />}
                            label={
                              <Box>
                                <Typography>{stampName(stamp)}</Typography>
                                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                  {stampLine(stamp, room, archived)}
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
                  {mode === 'copy' && selected.length > 0 ? (
                    <Box component="section" aria-label="before the copy starts">
                      <Typography variant="subtitle2" component="h3" gutterBottom>
                        Before it starts
                      </Typography>
                      <Stack spacing={0.5}>
                        {furtherCopyLines(selected, target === BUY_NEW ? 'new' : chosen).map((line) => (
                          <Typography key={line} variant="body2">
                            {line}
                          </Typography>
                        ))}
                      </Stack>
                    </Box>
                  ) : null}
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
                {busy ? 'Starting…' : startText}
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            {/* The dialog is named by the title's text alone, so the link beside it keeps an id of its own. */}
            <DialogTitle id="archive-panel-title-row" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <span id="archive-panel-title">{current ? `Archive of “${current.streamTitle}”` : 'Archive'}</span>
              {current ? (
                <Tooltip title={STREAM_PAGE_LINK_LABEL}>
                  <IconButton
                    component={RouterLink}
                    to={`/streams/${current.streamId}`}
                    size="small"
                    aria-label={STREAM_PAGE_LINK_LABEL}
                    onClick={(event: MouseEvent) => {
                      if (isPlainClick(event)) closePanel();
                    }}
                  >
                    <ArrowOutwardIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              ) : null}
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
                        <Button variant="contained" onClick={() => setBuyFor(awaitingId)}>
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
          onClose={() => setBuyFor(null)}
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
