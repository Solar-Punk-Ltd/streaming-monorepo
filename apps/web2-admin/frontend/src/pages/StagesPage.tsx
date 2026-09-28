import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { CatalogueStampSummary, StageSummary } from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { formatAgo } from '../dateUtil';
import { errorMessage } from '../errors';
import { CatalogueStampCard } from '../components/stages/CatalogueStampCard';
import { ChequebookChip, ReadinessChip, StampNumbers, StampStateChip } from '../components/stages/stamps';

/** How often "last confirmed" is worked out again. The manager confirms every stage every 30 seconds. */
const CLOCK_TICK_MS = 30_000;

const ENGINE_LABEL: Record<StageSummary['engine'], string> = { srs: 'SRS', ome: 'OvenMediaEngine' };

function StageName({ stage }: { stage: StageSummary }) {
  return (
    <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
      <Typography variant="body2">{stage.name}</Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {stage.kind} on {ENGINE_LABEL[stage.engine]}
        {stage.stackVersion ? `, stack ${stage.stackVersion}` : ''}
      </Typography>
      {stage.retiredAt ? <Chip size="small" variant="outlined" label="Retired" /> : null}
      {stage.supported ? null : (
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          label={`Not supported yet (${ENGINE_LABEL[stage.engine]})`}
        />
      )}
    </Stack>
  );
}

function Ingest({ stage }: { stage: StageSummary }) {
  const { ingest } = stage;
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
        {ingest.host}:{ingest.srtPort}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        SRT, {ingest.hasSrtPassphrase ? 'with a passphrase' : 'no passphrase'}
        {ingest.rtmpPublic ? `; RTMP on ${ingest.rtmpPort}` : ''}
      </Typography>
    </Stack>
  );
}

/**
 * Which token the stage's uploader presents to the admin. A stage still on the shared token is answered about every
 * stream, not only its own, until the manager gives it a token of its own.
 */
function UploaderToken({ stage }: { stage: StageSummary }) {
  switch (stage.adminTokenKind) {
    case 'own':
      return (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Its own token
        </Typography>
      );
    case 'shared':
      return (
        <Typography variant="caption" sx={{ color: 'warning.main' }}>
          Still on the shared token: rotate it in the manager.
        </Typography>
      );
    case null:
      return (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          No token pushed
        </Typography>
      );
  }
}

function Rungs({ stage }: { stage: StageSummary }) {
  if (stage.rungs.length === 0) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        No rungs reported
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      {stage.rungs.map((rung) => (
        <Stack key={rung.name} spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2">{rung.name}</Typography>
            {rung.stamp ? <StampStateChip state={rung.stamp.state} /> : null}
            {rung.chequebook ? <ChequebookChip health={rung.chequebook.health} /> : null}
          </Stack>
          {rung.stamp ? (
            <StampNumbers
              state={rung.stamp.state}
              ttlSeconds={rung.stamp.ttlSeconds}
              fillRatio={rung.stamp.fillRatio}
            />
          ) : (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              No stamp reading
            </Typography>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The stages the manager runs for the brand, as it last pushed them, and the brand's catalogue stamp. Read only: the
 * manager registers, changes and retires a stage, and every top-up happens in the manager's console.
 */
export function StagesPage() {
  const [stages, setStages] = useState<StageSummary[] | null>(null);
  const [stamp, setStamp] = useState<CatalogueStampSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.fetchStages(), api.fetchCatalogueStamp()])
      .then(([nextStages, nextStamp]) => {
        setStages(nextStages);
        setStamp(nextStamp);
        setNow(Date.now());
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load the stages')));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          Stages
        </Typography>
        <Tooltip title="Refresh">
          <IconButton aria-label="refresh stages" onClick={load}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}

      {!stages && !error ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress aria-label="Loading stages" />
        </Box>
      ) : null}

      {stages ? <CatalogueStampCard stamp={stamp} now={now} /> : null}

      {stages && stages.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
          <Typography variant="body1" gutterBottom>
            No stages yet.
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Stages appear here once the manager&apos;s admin link points at this admin. The manager then registers every
            stream uploader it runs for the brand, and confirms each one every 30 seconds.
          </Typography>
        </Paper>
      ) : null}

      {stages && stages.length > 0 ? (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Stage</TableCell>
                <TableCell>Readiness</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Ingest</TableCell>
                <TableCell>Rungs</TableCell>
                <TableCell>Last confirmed</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stages.map((stage) => (
                <TableRow key={stage.stageId} sx={stage.retiredAt ? { opacity: 0.6 } : undefined}>
                  <TableCell>
                    <StageName stage={stage} />
                  </TableCell>
                  <TableCell>
                    <ReadinessChip tone={stage.readiness.tone} reasons={stage.readiness.reasons} />
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      <Typography variant="body2">{stage.status}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        Uploader: {stage.uploader ? stage.uploader.state : 'not read'}
                      </Typography>
                      <UploaderToken stage={stage} />
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Ingest stage={stage} />
                  </TableCell>
                  <TableCell>
                    <Rungs stage={stage} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{formatAgo(stage.observedAt, now)}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
    </Stack>
  );
}
