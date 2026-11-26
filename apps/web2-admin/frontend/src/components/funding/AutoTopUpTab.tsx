import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
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
  NOTICE_SERVICE_NAMES,
  NOTICE_TOPIC_GROUPS,
  NOTICE_TOPIC_NAMES,
  noticePeople,
  UNMARKED_STAMP_LAST_DAYS,
  unmarkedStampTopic,
  type AutoTopUpComing,
  type AutoTopUpJob,
  type AutoTopUpJobState,
  type AutoTopUpStampState,
  type AutoTopUpUnmarkedStamp,
  type AutoTopUpUnmarkedView,
  type AutoTopUpView,
  type AutoTopUpWarning,
  type AutoTopUpWarningKind,
  type FundingView,
  type NoticeServiceView,
  type NoticesView,
  type NoticeTopic,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatAgo, formatDateTime } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { shortHex } from '../../format';
import { ApiError } from '../../http';
import { monoFont } from '../../theme/createAdminTheme';
import { destinationsText, serviceSetUpText, yourDestination } from '../notifications/noticeText';
import { useNotices, type NoticesRead } from '../notifications/useNotices';
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

/** The topic each warning goes out under: the two of the brand wallet share one, and the others are their own. */
const WARNING_TOPICS: Readonly<Record<AutoTopUpWarningKind, NoticeTopic>> = {
  wallet_xbzz: 'wallet_low',
  wallet_xdai: 'wallet_low',
  topup_failed: 'topup_failed',
  stamp_expired: 'stamp_expired',
};

/** Whether nobody gets the notices of a topic, so what it tells of shows on this tab alone. Unknown while unread. */
function nobodyGets(notices: NoticesView | null, topic: NoticeTopic): boolean {
  return notices !== null && noticePeople(notices, topic) === 0;
}

/** Said of something whose topic nobody gets, beside it. */
function shownHereAlone(topic: NoticeTopic): string {
  return `Nobody gets "${NOTICE_TOPIC_NAMES[topic]}", so it shows here alone.`;
}

/**
 * The warnings that stand, each with since when and when a notice last told of it, or that nobody gets its topic and
 * it shows here alone, or a line saying there are none.
 */
function Warnings({ warnings, notices }: { warnings: readonly AutoTopUpWarning[]; notices: NoticesView | null }) {
  if (warnings.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        No warnings.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      {warnings.map((warning) => {
        const since = `Since ${formatDateTime(warning.since)}`;
        const topic = WARNING_TOPICS[warning.kind];
        let notified = `${since}, not notified yet.`;
        if (warning.notifiedAt) notified = `${since}, notified ${formatDateTime(warning.notifiedAt)}.`;
        else if (nobodyGets(notices, topic)) notified = `${since}. ${shownHereAlone(topic)}`;
        return (
          <Alert key={`${warning.kind}:${warning.batchId ?? ''}:${warning.since}`} severity="warning">
            <Stack spacing={0.25}>
              <span>{warning.message}</span>
              <Typography variant="caption">{notified}</Typography>
            </Stack>
          </Alert>
        );
      })}
    </Stack>
  );
}

/** The stamps not on auto top-up that are running low, as the tab reads them: the list once read, or why it was not. */
interface UnmarkedRead {
  view: AutoTopUpUnmarkedView | null;
  error: string | null;
  load: () => void;
}

/**
 * Reads `GET /api/funding/auto-top-up/unmarked` when the tab mounts, and again on `load`. Only the latest read is
 * answered.
 */
function useUnmarked(): UnmarkedRead {
  const [view, setView] = useState<AutoTopUpUnmarkedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);

  const load = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    setError(null);
    api
      .fetchAutoTopUpUnmarked()
      .then((next) => {
        if (read === reads.current) setView(next);
      })
      .catch((e: unknown) => {
        if (read === reads.current) setError(errorMessage(e, 'The list could not be read.'));
      });
  }, []);

  useEffect(load, [load]);

  return { view, error, load };
}

/** The node a stamp is on, by its label on the Funding view, or by its id while the view does not list it. */
function nodeName(funding: FundingView | null, nodeId: string): string {
  const nodes = [
    ...(funding?.catalogue ? [funding.catalogue] : []),
    ...(funding?.stages ?? []).flatMap((s) => s.nodes),
  ];
  return nodes.find((node) => node.nodeId === nodeId)?.label ?? nodeId;
}

/** Where a low unmarked stamp stands, and since when: under the threshold, under the last days, or expired. */
function levelText(stamp: AutoTopUpUnmarkedStamp, underDays: number): string {
  const under = `Under ${dayCount(underDays)} since ${formatDateTime(stamp.since)}`;
  switch (stamp.level) {
    case 'low':
      return `${under}.`;
    case 'last':
      return `${under}, under ${dayCount(UNMARKED_STAMP_LAST_DAYS)} since ${formatDateTime(stamp.levelSince)}.`;
    case 'expired':
      return `Expired since ${formatDateTime(stamp.levelSince)}.`;
  }
}

/** How an unmarked stamp's level reads as an alert: blue while low, orange in its last days, red once it ran out. */
const LEVEL_SEVERITY = { low: 'info', last: 'warning', expired: 'error' } as const;

/**
 * The stamps not on auto top-up that are running low, the one with the least time left first: what the alert job said
 * of each, the topic it goes out under, its node and batch, since when it has been low, and when a notice last told
 * of it, or that nobody gets its topic. `docs/architecture/funding.md`, "Stamps not on auto top-up".
 */
function Unmarked({
  read,
  underDays,
  funding,
  notices,
}: {
  read: UnmarkedRead;
  underDays: number;
  funding: FundingView | null;
  notices: NoticesView | null;
}) {
  if (read.error) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={read.load}>
            Retry
          </Button>
        }
      >
        {`The stamps not on auto top-up could not be read: ${read.error}`}
      </Alert>
    );
  }
  if (read.view === null) return null;
  if (read.view.stamps.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        No stamp off auto top-up is running low.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      {read.view.stamps.map((stamp) => {
        const topic = unmarkedStampTopic(stamp.holder);
        let notified = 'Not notified yet.';
        if (stamp.notifiedAt) notified = `Notified ${formatDateTime(stamp.notifiedAt)}.`;
        else if (nobodyGets(notices, topic)) notified = shownHereAlone(topic);
        return (
          <Alert key={`${stamp.nodeId}:${stamp.batchId}`} severity={LEVEL_SEVERITY[stamp.level]}>
            <Stack spacing={0.25}>
              <span>{stamp.message}</span>
              <Typography variant="caption">
                {`${NOTICE_TOPIC_NAMES[topic]} · ${nodeName(funding, stamp.nodeId)} · `}
                <Box component="span" title={stamp.batchId} sx={{ fontFamily: monoFont }}>
                  {shortHex(stamp.batchId)}
                </Box>
              </Typography>
              <Typography variant="caption">{`${levelText(stamp, underDays)} ${notified}`}</Typography>
            </Stack>
          </Alert>
        );
      })}
    </Stack>
  );
}

/**
 * Where things stand: the estimate beside the brand wallet, the ceiling, today's sends, what is coming, the warnings
 * and the stamps not on auto top-up that are running low.
 */
function Standing({
  view,
  funding,
  notices,
  unmarked,
}: {
  view: AutoTopUpView;
  funding: FundingView | null;
  notices: NoticesView | null;
  unmarked: UnmarkedRead;
}) {
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
      <Typography variant="subtitle2" component="h3">
        Top-ups coming up
      </Typography>
      <Coming stamps={view.stamps} />
      <Typography variant="subtitle2" component="h3">
        Warnings
      </Typography>
      <Warnings warnings={view.warnings} notices={notices} />
      <Typography variant="subtitle2" component="h3">
        Stamps not on auto top-up
      </Typography>
      <Unmarked read={unmarked} underDays={view.settings.topUpUnderDays} funding={funding} notices={notices} />
    </Section>
  );
}

/** How many people get a topic's notices, beside its name, or that nobody does and it shows here alone. */
function reachLine(people: number): string {
  if (people === 0) return 'Nobody: it shows here alone.';
  return people === 1 ? '1 person gets it.' : `${people} people get it.`;
}

/**
 * A service as every user reads it here: whether it is set up and on, when it last took a notice, how many
 * destinations on it are on and how many of those failed their last notice, and its latest failure. Counts alone of
 * the users.
 */
function ServiceLine({ service, now }: { service: NoticeServiceView; now: number }) {
  const name = NOTICE_SERVICE_NAMES[service.kind];
  let state = `${name}: not set up.`;
  if (service.saved) {
    const last = service.lastSentAt ? `last took a notice ${formatAgo(service.lastSentAt, now)}` : 'no notice sent yet';
    state = `${name}: ${serviceSetUpText(service)}, ${last}. ${destinationsText(service)}`;
  }
  return (
    <Stack spacing={0.25} data-service={service.kind}>
      <Typography variant="body2">{state}</Typography>
      {service.lastFailure ? (
        <Typography variant="caption" sx={{ color: 'error.main' }}>
          {`The latest failure${service.lastFailureAt ? `, ${formatAgo(service.lastFailureAt, now)}` : ''}: ${service.lastFailure}`}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * The notices: beside each kind, how many people get it, or that nobody does and it shows here alone; each service,
 * with how many of its destinations failed; and the viewer's own destinations that failed, with why. Each user sets
 * theirs on the Notifications page. It reads `GET /api/notifications`, as that page does.
 */
function Notices({ read, now }: { read: NoticesRead; now: number }) {
  const { view } = read;
  const failed = (view?.destinations ?? []).filter(
    (destination) => destination.address !== null && destination.lastError !== null,
  );
  return (
    <Section title="Notices">
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Who gets each notice of auto top-up. Each user sets where their own notices go, and which ones they get, on the
        Notifications page.
      </Typography>
      {read.error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={read.load}>
              Retry
            </Button>
          }
        >
          {`The notices could not be read: ${read.error}`}
        </Alert>
      ) : null}
      {view ? (
        <>
          {NOTICE_TOPIC_GROUPS.map((group) => (
            <Stack key={group.name} spacing={0.5}>
              <Typography variant="subtitle2" component="h3">
                {group.name}
              </Typography>
              {group.topics.map((topic) => (
                <Fact key={topic} label={NOTICE_TOPIC_NAMES[topic]}>
                  {reachLine(noticePeople(view, topic))}
                </Fact>
              ))}
            </Stack>
          ))}
          <Stack spacing={0.5}>
            <Typography variant="subtitle2" component="h3">
              Services
            </Typography>
            {view.services.map((service) => (
              <ServiceLine key={service.kind} service={service} now={now} />
            ))}
          </Stack>
          {failed.length > 0 ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" component="h3">
                Yours
              </Typography>
              {failed.map((destination) => (
                <Typography key={destination.kind} variant="body2" sx={{ color: 'error.main' }}>
                  {`The last notice to ${yourDestination(destination.kind)} could not be sent${destination.lastErrorAt ? ` ${formatAgo(destination.lastErrorAt, now)}` : ''}: ${destination.lastError}`}
                </Typography>
              ))}
            </Stack>
          ) : null}
          <Link component={RouterLink} to="/notifications" variant="body2">
            Choose your notices on the Notifications page
          </Link>
        </>
      ) : null}
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
 * ceiling in force, what the wallet job sent in the last 24 hours, the top-ups coming up, the warnings and the stamps
 * not on auto top-up that are running low; then the notices, how many people get each kind and how each service
 * stands, read from the Notifications page's view; then the jobs with their pause switches; then the numbers, saved
 * behind the password. Each write answers the whole view, which the tab then shows. The numbers as typed, `draft`, are
 * the Funding page's, so they stay while another tab is shown. `docs/architecture/funding.md`, "Auto top-up tab".
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
  const notices = useNotices();
  const unmarked = useUnmarked();
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
          <Standing view={view} funding={funding.view} notices={notices.view} unmarked={unmarked} />
          <Notices read={notices} now={funding.now} />
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
