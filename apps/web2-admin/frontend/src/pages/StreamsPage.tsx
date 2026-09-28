import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Alert,
  Box,
  Button,
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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ImageNotSupportedOutlinedIcon from '@mui/icons-material/ImageNotSupportedOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { StageSummary, Stream } from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MediaTypeChip, StatusChip } from '../components/StatusChip';
import { useSnackbar } from '../components/Snackbar';
import { unknownStageLabel } from '../components/stages/StageField';

/** The filter's two values that are not a stage id. */
const ALL_STAGES = 'all';
const NO_STAGE = 'none';

/** A stage's name, and that it was retired when it was. */
function stageLabel(stage: StageSummary): string {
  return stage.retiredAt ? `${stage.name} (retired)` : stage.name;
}

function StageName({ stageId, stages }: { stageId: string | null; stages: ReadonlyMap<string, StageSummary> }) {
  if (!stageId) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        No stage
      </Typography>
    );
  }
  const stage = stages.get(stageId);
  return (
    <Typography variant="body2" sx={stage?.retiredAt ? { color: 'text.secondary' } : undefined}>
      {stage ? stageLabel(stage) : unknownStageLabel(stageId)}
    </Typography>
  );
}

function Thumbnail({ stream }: { stream: Stream }) {
  if (!stream.hasThumbnail) {
    return (
      <Box
        sx={{
          width: 96,
          height: 54,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 1,
          bgcolor: 'action.hover',
          color: 'text.disabled',
        }}
      >
        <ImageNotSupportedOutlinedIcon fontSize="small" />
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={api.thumbnailUrl(stream)}
      alt={`${stream.title} thumbnail`}
      sx={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 1 }}
    />
  );
}

export function StreamsPage() {
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Stream | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [stages, setStages] = useState<ReadonlyMap<string, StageSummary>>(new Map());
  const [stageFilter, setStageFilter] = useState(ALL_STAGES);

  const load = useCallback(() => {
    setError(null);
    api
      .fetchStreams()
      .then(setStreams)
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load streams')));
    // Only for the names in the Stage column and the filter. The list stands
    // without them, and names each stage by its id instead.
    api
      .fetchStages()
      .then((list) => setStages(new Map(list.map((stage) => [stage.stageId, stage]))))
      .catch(() => undefined);
  }, []);

  // Every stage the manager pushed, retired ones included, and any stage a
  // stream names that the list does not hold, so no stream is out of reach.
  const filterOptions = [...stages.values()].map((stage) => ({ value: stage.stageId, label: stageLabel(stage) }));
  for (const stream of streams ?? []) {
    const { stageId } = stream;
    if (stageId && !stages.has(stageId) && !filterOptions.some((option) => option.value === stageId)) {
      filterOptions.push({ value: stageId, label: unknownStageLabel(stageId) });
    }
  }
  const shown =
    streams?.filter((stream) =>
      stageFilter === ALL_STAGES ? true : stageFilter === NO_STAGE ? !stream.stageId : stream.stageId === stageFilter,
    ) ?? null;

  useEffect(load, [load]);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.deleteStream(toDelete.id);
      setStreams((prev) => prev?.filter((s) => s.id !== toDelete.id) ?? null);
      snackbar.success(`"${toDelete.title}" deleted.`);
      setToDelete(null);
    } catch (e) {
      snackbar.error(errorMessage(e, 'Failed to delete the stream'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          Streams
        </Typography>
        {/* `publishing` is transient and nothing pushes the transition here. */}
        <Tooltip title="Refresh">
          <IconButton aria-label="refresh streams" onClick={load}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/create')}>
          Create New Stream
        </Button>
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

      {!streams && !error ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress aria-label="Loading streams" />
        </Box>
      ) : null}

      {streams && streams.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
          <Typography variant="body1" gutterBottom>
            No streams yet.
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Create the first one to get its OBS connection details, then publish it to the stream list.
          </Typography>
        </Paper>
      ) : null}

      {streams && streams.length > 0 ? (
        <TextField
          id="streams-stage-filter"
          label="Stage"
          select
          size="small"
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          sx={{ alignSelf: 'flex-start', minWidth: 220, maxWidth: '100%' }}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
        >
          <option value={ALL_STAGES}>All stages</option>
          {filterOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value={NO_STAGE}>No stage</option>
        </TextField>
      ) : null}

      {shown && streams && streams.length > 0 && shown.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No streams on this stage.
          </Typography>
        </Paper>
      ) : null}

      {shown && shown.length > 0 ? (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell />
                <TableCell>Title</TableCell>
                <TableCell>Stage</TableCell>
                <TableCell>Media type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Scheduled start</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((stream) => (
                <TableRow key={stream.id} hover>
                  <TableCell sx={{ width: 112 }}>
                    <Thumbnail stream={stream} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{stream.title}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {stream.description}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <StageName stageId={stream.stageId} stages={stages} />
                  </TableCell>
                  <TableCell>
                    <MediaTypeChip mediaType={stream.mediaType} />
                  </TableCell>
                  <TableCell>
                    <StatusChip status={stream.status} publishError={stream.publishError} />
                  </TableCell>
                  <TableCell>{formatDateTime(stream.scheduledStartTime)}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      <Button size="small" startIcon={<EditIcon />} onClick={() => navigate(`/edit/${stream.id}`)}>
                        Edit
                      </Button>
                      <Button
                        size="small"
                        startIcon={<InfoOutlinedIcon />}
                        onClick={() => navigate(`/streams/${stream.id}`)}
                      >
                        Details
                      </Button>
                      <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => setToDelete(stream)}>
                        Delete
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete Stream"
        message={`Are you sure you want to delete "${toDelete?.title ?? ''}"?`}
        confirmText={deleting ? 'Deleting…' : 'Delete'}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      />
    </Stack>
  );
}
