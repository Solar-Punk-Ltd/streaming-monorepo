import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import {
  NOTIFICATION_CHANNEL_NAMES,
  notificationsOn,
  type AutoTopUpComing,
  type AutoTopUpJob,
  type AutoTopUpJobState,
  type AutoTopUpStampState,
  type AutoTopUpView,
  type AutoTopUpWarning,
  type FundingView,
  type NotificationChannelStatus,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo, formatDateTime } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { shortHex } from '../../format';
import { ApiError } from '../../http';
import { monoFont } from '../../theme/createAdminTheme';
import {
  numbersDraftOf,
  readNumbersDraft,
  RUN_MINUTES,
  sameSettings,
  xbzzText,
  xdaiText,
  type AutoTopUpDraft,
  type NumbersDraft,
} from './autoTopUp';
import { autoTopUpUnread, useAutoTopUp } from './AutoTopUpMarks';
import { FundingFrame, useFundingView } from './FundingFrame';
import { PasswordDialog } from './PasswordDialog';
import { dayCount } from './stamps';

/** The Funding view is read for the brand wallet's balances alone, so a reading asks nothing more of the tab. */
const NO_FOLLOW = () => undefined;

/** A part of the tab: a heading and what is under it, in an outlined box. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-section>
      <Stack spacing={1.5}>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  );
}

/** A label with its value beside it, the value the label's next sibling. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0, sm: 2 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', minWidth: { sm: 220 } }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {children}
      </Typography>
    </Stack>
  );
}

/** What the brand wallet will send a stamp's node for its top-up. */
function sendText(coming: AutoTopUpComing): string {
  if (coming.sendPlur === '0') return coming.gasSend ? 'Gas' : 'Nothing: its node holds enough';
  return `${xbzzText(coming.sendPlur)}${coming.gasSend ? ' and gas' : ''}`;
}

/** The top-ups coming up, the soonest first, or a line saying there are none. */
function Coming({ stamps }: { stamps: readonly AutoTopUpStampState[] }) {
  const coming = stamps
    .flatMap((stamp) => (stamp.coming ? [{ stamp, next: stamp.coming }] : []))
    .sort((a, b) => a.next.dueAt.localeCompare(b.next.dueAt));
  if (coming.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        No top-ups coming up.
      </Typography>
    );
  }
  return (
    <TableContainer>
      <Table size="small" aria-label="Top-ups coming up">
        <TableHead>
          <TableRow>
            <TableCell>Stamp</TableCell>
            <TableCell>Due</TableCell>
            <TableCell align="right">Days</TableCell>
            <TableCell align="right">Cost</TableCell>
            <TableCell align="right">With margin</TableCell>
            <TableCell>The brand wallet sends</TableCell>
            <TableCell>Notice</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {coming.map(({ stamp, next }) => (
            <TableRow key={stamp.batchId}>
              <TableCell>
                <Stack>
                  <Typography variant="body2">{stamp.nodeLabel}</Typography>
                  <Typography variant="caption" title={stamp.batchId} sx={{ fontFamily: monoFont }}>
                    {shortHex(stamp.batchId)}
                  </Typography>
                </Stack>
              </TableCell>
              <TableCell>{next.due ? 'Due now' : formatDateTime(next.dueAt)}</TableCell>
              <TableCell align="right">{dayCount(next.days)}</TableCell>
              <TableCell align="right">{xbzzText(next.costPlur)}</TableCell>
              <TableCell align="right">{xbzzText(next.costWithMarginPlur)}</TableCell>
              <TableCell>{sendText(next)}</TableCell>
              <TableCell>
                <Stack>
                  <Typography variant="body2">
                    {next.alertedAt ? `Alerted ${formatDateTime(next.alertedAt)}` : 'No alert yet'}
                  </Typography>
                  {next.sendAt ? (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {`Sent from ${formatDateTime(next.sendAt)}`}
                    </Typography>
                  ) : null}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** The warnings that stand, each with since when and when a notice last told of it, or a line saying there are none. */
function Warnings({ warnings }: { warnings: readonly AutoTopUpWarning[] }) {
  if (warnings.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        No warnings.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      {warnings.map((warning) => (
        <Alert key={`${warning.kind}:${warning.batchId ?? ''}:${warning.since}`} severity="warning">
          <Stack spacing={0.25}>
            <span>{warning.message}</span>
            <Typography variant="caption">
              {`Since ${formatDateTime(warning.since)}, ${warning.notifiedAt ? `notified ${formatDateTime(warning.notifiedAt)}` : 'not notified yet'}.`}
            </Typography>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}

/** A channel's status line: not set up, or on or off with its last notice, and its last failure under it. */
function ChannelLine({ channel, now }: { channel: NotificationChannelStatus; now: number }) {
  const name = NOTIFICATION_CHANNEL_NAMES[channel.kind];
  let state = `${name}: not set up.`;
  if (channel.saved) {
    const last = channel.lastSentAt ? `last sent ${formatAgo(channel.lastSentAt, now)}` : 'nothing sent yet';
    state = `${name}: ${channel.enabled ? 'on' : 'off'}, ${last}.`;
  }
  const when = channel.lastErrorAt ? ` ${formatAgo(channel.lastErrorAt, now)}` : '';
  const waiting = channel.waiting === 1 ? ' 1 notice waits for it.' : ` ${channel.waiting} notices wait for it.`;
  return (
    <Stack spacing={0.25} data-channel={channel.kind}>
      <Typography variant="body2">{state}</Typography>
      {channel.lastError ? (
        <Typography variant="caption" sx={{ color: 'error.main' }}>
          {`The last notice could not be sent${when}: ${channel.lastError}${channel.waiting > 0 ? waiting : ''}`}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * Where the alerts and warnings go: a status line per notification channel, with a link to the Notifications page
 * where they are set up. With none on, they show on this page alone.
 */
function ChannelStates({ view, now }: { view: AutoTopUpView; now: number }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle2" component="h3">
        Notifications
      </Typography>
      {notificationsOn(view.notifications) ? null : (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          No channel is on, so the alerts and warnings show on this page alone.
        </Typography>
      )}
      {view.notifications.map((channel) => (
        <ChannelLine key={channel.kind} channel={channel} now={now} />
      ))}
      <Link component={RouterLink} to="/notifications" variant="body2">
        Set the channels up on the Notifications page
      </Link>
    </Stack>
  );
}

/** Where things stand: the estimate beside the brand wallet, the ceiling, today's sends, the channels, what is coming. */
function Standing({ view, funding, now }: { view: AutoTopUpView; funding: FundingView | null; now: number }) {
  const wallet = funding?.wallet ?? null;
  const walletText =
    wallet && wallet.xbzzPlur !== null && wallet.xdaiWei !== null
      ? `${xbzzText(wallet.xbzzPlur)} · ${xdaiText(wallet.xdaiWei)}`
      : 'Not read';
  const follows = view.settings.dailyCeilingPlur === null;
  return (
    <Section title="Where things stand">
      <Stack spacing={0.5}>
        <Fact label="Monthly estimate">
          {view.monthlyEstimatePlur === null
            ? 'Not known: the manager or the price of postage could not be read.'
            : xbzzText(view.monthlyEstimatePlur)}
        </Fact>
        <Fact label="Brand wallet">{walletText}</Fact>
        <Fact label="Daily ceiling in force">
          {view.dailyCeilingPlur === null
            ? 'None while there is no estimate to follow.'
            : `${xbzzText(view.dailyCeilingPlur)}${follows ? ', half the monthly estimate' : ''}`}
        </Fact>
        <Fact label="Sent in the last 24 hours">{xbzzText(view.sentTodayPlur)}</Fact>
      </Stack>
      <ChannelStates view={view} now={now} />
      <Typography variant="subtitle2" component="h3">
        Top-ups coming up
      </Typography>
      <Coming stamps={view.stamps} />
      <Typography variant="subtitle2" component="h3">
        Warnings
      </Typography>
      <Warnings warnings={view.warnings} />
    </Section>
  );
}

const JOB_TITLES: Readonly<Record<AutoTopUpJob, string>> = {
  alert: 'Alert job',
  wallet: 'Wallet job',
  stamp: 'Stamp job',
};

const JOB_TEXTS: Readonly<Record<AutoTopUpJob, string>> = {
  alert: 'Announces each top-up before it falls due, and raises the warnings. It moves no money.',
  wallet: 'Sends a short node what its due top-up lacks from the brand wallet, once the alert is old enough.',
  stamp: 'Tops up the due marked stamps whose node holds enough.',
};

/** One job: its pause switch, on while it runs, whether and by whom it is paused, and its last run. */
function JobLine({
  job,
  now,
  busy,
  onPause,
}: {
  job: AutoTopUpJobState;
  now: number;
  busy: boolean;
  onPause: (paused: boolean) => void;
}) {
  let state = 'Running.';
  if (job.paused) {
    state = job.pausedAt
      ? `Paused by ${job.pausedBy ?? 'someone'}, ${formatAgo(job.pausedAt, Date.now())}.`
      : 'Paused.';
  }
  return (
    <Stack spacing={0.25}>
      <FormControlLabel
        control={<Switch checked={!job.paused} disabled={busy} onChange={(event) => onPause(!event.target.checked)} />}
        label={JOB_TITLES[job.job]}
      />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {JOB_TEXTS[job.job]}
      </Typography>
      <Typography variant="caption">{state}</Typography>
      <Typography variant="caption" sx={{ color: job.lastOk === false ? 'error.main' : 'text.secondary' }}>
        {job.lastRunAt ? `Last run ${formatAgo(job.lastRunAt, now)}: ${job.lastOutcome ?? ''}` : 'Not run yet.'}
      </Typography>
    </Stack>
  );
}

/** The three jobs, each with its pause switch. */
function Jobs({ view, now, onView }: { view: AutoTopUpView; now: number; onView: (next: AutoTopUpView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pause = async (job: AutoTopUpJob, paused: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onView(await api.setAutoTopUpJob(job, paused));
    } catch (e: unknown) {
      setError(errorMessage(e, 'The job could not be paused or resumed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Jobs">
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {`The three jobs run every ${RUN_MINUTES} minutes, in this order. A paused job is skipped.`}
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {view.jobs.map((job) => (
        <JobLine key={job.job} job={job} now={now} busy={busy} onPause={(paused) => void pause(job.job, paused)} />
      ))}
    </Section>
  );
}

/** The fields of the numbers: the label each has, and a line under it. */
const NUMBER_FIELDS: readonly { key: keyof NumbersDraft; label: string; help: string }[] = [
  { key: 'topUpUnderDays', label: 'Top up when under (days)', help: 'A marked stamp with less time left is due.' },
  { key: 'topUpToDays', label: 'Top up to (days)', help: 'The level a due stamp is brought back to.' },
  {
    key: 'lookAheadDays',
    label: 'Look ahead (days)',
    help: 'How long before a top-up falls due the alert goes out, and how long the wallet job waits after it.',
  },
  {
    key: 'marginPercent',
    label: 'Margin (%)',
    help: 'Added to the cost in the alert and to what the wallet job sends.',
  },
  { key: 'xdaiWarning', label: 'xDAI warning (xDAI)', help: 'The brand wallet holding less is warned about.' },
  { key: 'dailyCeiling', label: 'Daily ceiling (xBZZ)', help: 'Empty, it follows half the monthly estimate.' },
];

/**
 * The numbers, as typed, with every reason they cannot be saved shown before a save, and Save numbers, which asks for
 * the password since they bound what the wallet job sends with none.
 */
function Numbers({
  view,
  draft,
  onDraft,
  onView,
}: {
  view: AutoTopUpView;
  draft: NumbersDraft | null;
  onDraft: (next: NumbersDraft | null) => void;
  onView: (next: AutoTopUpView) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? numbersDraftOf(view.settings);
  const read = readNumbersDraft(shown);
  const changed = !sameSettings(read.settings, view.settings);

  const save = async (password: string): Promise<'wrong-password' | void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveAutoTopUpSettings(password, read.settings);
      onView(next);
      onDraft(null);
      setAsking(false);
    } catch (e: unknown) {
      setError(errorMessage(e, 'The auto top-up numbers could not be saved.'));
      if (e instanceof ApiError && e.code === 'invalid_credentials') return 'wrong-password';
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Section title="Numbers">
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        {NUMBER_FIELDS.map(({ key, label, help }) => (
          <TextField
            key={key}
            id={`auto-top-up-${key}`}
            label={label}
            value={shown[key]}
            onChange={(event) => onDraft({ ...shown, [key]: event.target.value })}
            helperText={help}
            size="small"
            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          />
        ))}
      </Box>
      {read.problems.map((problem) => (
        <Typography key={problem} variant="caption" sx={{ color: 'error.main' }}>
          {problem}
        </Typography>
      ))}
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {view.settingsSavedAt
          ? `Saved by ${view.settingsSavedBy ?? 'someone'}, ${formatAgo(view.settingsSavedAt, Date.now())}.`
          : 'The defaults: never saved.'}
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          disabled={read.problems.length > 0 || !changed}
          onClick={() => {
            setError(null);
            setAsking(true);
          }}
        >
          Save numbers
        </Button>
        <Button disabled={draft === null} onClick={() => onDraft(null)}>
          Undo changes
        </Button>
      </Stack>
      {asking ? (
        <PasswordDialog
          title="Save the auto top-up numbers"
          confirmText="Save"
          busy={busy}
          error={error}
          onConfirm={save}
          onCancel={() => setAsking(false)}
        >
          <Typography variant="body2">
            These numbers bound what the wallet job sends from the brand wallet with no password, so saving them takes
            yours.
          </Typography>
        </PasswordDialog>
      ) : null}
    </Section>
  );
}

/**
 * The Auto top-up tab: the settings of stamp auto top-up and what its three jobs are doing. Where things stand comes
 * first, the monthly estimate for the marked stamps beside the brand wallet's balances from the Funding view, the daily
 * ceiling in force, what the wallet job sent in the last 24 hours, how each notification channel stands with a link to
 * the Notifications page, the top-ups coming up and the warnings; then the jobs with their pause switches; then the
 * numbers, saved behind the password. Each write answers the whole view, which the tab then shows. The numbers as
 * typed, `draft`, are the Funding page's, so they stay while another tab is shown. `docs/architecture/funding.md`,
 * "Auto top-up tab".
 */
export function AutoTopUpTab({
  draft,
  onDraft,
}: {
  draft: AutoTopUpDraft;
  onDraft: Dispatch<SetStateAction<AutoTopUpDraft>>;
}) {
  const funding = useFundingView(NO_FOLLOW);
  const auto = useAutoTopUp();
  const { view } = auto;

  return (
    <Stack spacing={3}>
      <FundingFrame read={funding} readLine={(ago) => `Balances as the manager read them ${ago}.`} />
      {auto.error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={auto.load}>
              Retry
            </Button>
          }
        >
          {autoTopUpUnread(auto.error)}
        </Alert>
      ) : null}
      {view ? (
        <>
          <Standing view={view} funding={funding.view} now={funding.now} />
          <Jobs view={view} now={funding.now} onView={auto.setView} />
          <Numbers
            view={view}
            draft={draft.numbers}
            onDraft={(numbers) => onDraft((current) => ({ ...current, numbers }))}
            onView={auto.setView}
          />
        </>
      ) : null}
    </Stack>
  );
}
