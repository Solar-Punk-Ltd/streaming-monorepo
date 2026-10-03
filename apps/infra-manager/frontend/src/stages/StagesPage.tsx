import {
  Alert,
  Button,
  CircularProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import { useEditors } from '../app/EditorsContext';
import { routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { EmptyState } from '../components/EmptyState';
import { ReadinessPill } from '../components/ReadinessPill';
import { StatusDot } from '../components/StatusDot';
import type { Tone } from '../components/tone';
import { CopyButton } from '../CopyButton';
import { useSecondsTicker } from '../deployments/useStageRegistration';
import {
  readFailureLine,
  STAGES_LEAD,
  STAGES_NONE,
  STAGES_NONE_HINT,
  stageRows,
  type PushView,
  type StageRecordView,
  type StageRowView,
} from './stagesView';
import { useConsoleStages } from './useConsoleStages';

/** The columns a record fills, which a row whose record could not be built spans with the reason. */
const RECORD_COLUMNS = 5;

/**
 * Every stage of this manager, from `GET /stages`: the record the manager would push into the web2 admin now, and how
 * its last push went, read again every 30 seconds. Read only: a stage's ingest address and its uploader's token are
 * changed on its deployment page, which its name opens.
 */
export function StagesPage() {
  const { stages, readAt, error, reload } = useConsoleStages();
  const { openWizard } = useEditors();
  const now = useSecondsTicker(stages !== null && stages.length > 0);

  const failure = error && (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={reload}>
          Try again
        </Button>
      }
    >
      {readFailureLine(error, readAt, now)}
    </Alert>
  );

  if (stages === null) {
    return (
      failure || (
        <Stack sx={{ alignItems: 'center', py: 8 }}>
          <CircularProgress />
        </Stack>
      )
    );
  }

  const rows = stageRows(stages, now);

  return (
    <Stack spacing={1.75}>
      {failure}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', flex: 1 }}>
          {STAGES_LEAD}
        </Typography>
        <Button size="small" onClick={reload} sx={{ flex: 'none' }}>
          Refresh
        </Button>
      </Stack>

      {rows.length === 0 ? (
        <Paper>
          <EmptyState
            title={STAGES_NONE}
            hint={STAGES_NONE_HINT}
            action={
              <Button variant="contained" onClick={() => openWizard({ goal: 'stream' })}>
                New stream
              </Button>
            }
          />
        </Paper>
      ) : (
        <Paper sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Stage</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Readiness</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell>Ingest</TableCell>
                <TableCell>Token</TableCell>
                <TableCell>Last push</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <StageRow key={row.name} row={row} />
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      {rows.length > 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          A stage’s name opens its deployment page, where its public ingest address is set and its uploader’s admin
          token rotated.
        </Typography>
      )}
    </Stack>
  );
}

function StageRow({ row }: { row: StageRowView }) {
  return (
    <TableRow hover data-testid={`stage-${row.name}`} sx={{ verticalAlign: 'top' }}>
      <TableCell>
        <Link href={routes.deployment(row.name)} sx={{ fontFamily: MONO_STACK, fontWeight: 600, fontSize: 13 }}>
          {row.name}
        </Link>
        {row.record && <Caption>{row.record.kind}</Caption>}
        {row.record && row.problem && <Caption tone="warn">{row.problem}</Caption>}
      </TableCell>
      {row.record ? (
        <RecordCells record={row.record} name={row.name} />
      ) : (
        <TableCell colSpan={RECORD_COLUMNS}>
          <Typography variant="body2" sx={{ color: 'warning.main', overflowWrap: 'anywhere' }}>
            {row.problem}
          </Typography>
        </TableCell>
      )}
      <TableCell>
        <LastPush push={row.lastPush} />
      </TableCell>
    </TableRow>
  );
}

function RecordCells({ record, name }: { record: StageRecordView; name: string }) {
  const { status, readiness, owner, ingest, token } = record;
  return (
    <>
      <TableCell>
        <DotLabel tone={status.tone} pulsing={status.pulsing} label={status.label} />
      </TableCell>
      <TableCell>
        <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <ReadinessPill label={readiness.label} tone={readiness.tone} />
          {readiness.reasons.map((reason, index) => (
            <Caption key={`${index}:${reason}`}>{reason}</Caption>
          ))}
        </Stack>
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center' }}>
          <Typography
            variant="body2"
            title={owner.address}
            sx={{ fontFamily: MONO_STACK, fontSize: 13, whiteSpace: 'nowrap' }}
          >
            {owner.short}
          </Typography>
          <CopyButton value={owner.address} label={`${name} owner address`} />
        </Stack>
      </TableCell>
      <TableCell>
        <Typography variant="body2" sx={{ fontFamily: MONO_STACK, fontSize: 13, wordBreak: 'break-all' }}>
          {ingest.host}
        </Typography>
        <Caption>{ingest.ports}</Caption>
      </TableCell>
      <TableCell>
        <DotLabel tone={token.tone} label={token.label} />
        {token.note && (
          <Caption tone="err" maxWidth={240}>
            {token.note}
          </Caption>
        )}
      </TableCell>
    </>
  );
}

function LastPush({ push }: { push: PushView }) {
  return (
    <>
      <DotLabel tone={push.tone} label={push.label} title={push.at ?? undefined} />
      {push.ago && <Caption>{push.ago}</Caption>}
    </>
  );
}

function DotLabel({ tone, label, pulsing, title }: { tone: Tone; label: string; pulsing?: boolean; title?: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <StatusDot tone={tone} pulsing={pulsing} />
      <Typography variant="body2" title={title}>
        {label}
      </Typography>
    </Stack>
  );
}

const CAPTION_COLOR: Partial<Record<Tone, string>> = { warn: 'warning.main', err: 'error.main' };

function Caption({ tone, maxWidth, children }: { tone?: Tone; maxWidth?: number; children: string }) {
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ color: (tone && CAPTION_COLOR[tone]) ?? 'text.secondary', maxWidth, overflowWrap: 'anywhere' }}
    >
      {children}
    </Typography>
  );
}
