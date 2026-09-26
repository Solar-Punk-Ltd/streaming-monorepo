import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ImageNotSupportedOutlinedIcon from '@mui/icons-material/ImageNotSupportedOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { Stream } from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MediaTypeChip, StatusChip } from '../components/StatusChip';
import { useSnackbar } from '../components/Snackbar';

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

  const load = useCallback(() => {
    setError(null);
    api
      .fetchStreams()
      .then(setStreams)
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load streams')));
  }, []);

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
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          My Streams
        </Typography>
        {/* `publishing` is transient and nothing pushes the transition here. */}
        <Tooltip title="Refresh">
          <IconButton aria-label="refresh streams" onClick={load}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => navigate('/create')}
        >
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
          <Typography variant="body2" color="text.secondary">
            Create your first stream to get its OBS connection details, then
            publish it to the stream list.
          </Typography>
        </Paper>
      ) : null}

      {streams && streams.length > 0 ? (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell />
                <TableCell>Title</TableCell>
                <TableCell>Media type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Scheduled start</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {streams.map((stream) => (
                <TableRow key={stream.id} hover>
                  <TableCell sx={{ width: 112 }}>
                    <Thumbnail stream={stream} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{stream.title}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {stream.description}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <MediaTypeChip mediaType={stream.mediaType} />
                  </TableCell>
                  <TableCell>
                    <StatusChip
                      status={stream.status}
                      publishError={stream.publishError}
                    />
                  </TableCell>
                  <TableCell>{formatDateTime(stream.scheduledStartTime)}</TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      justifyContent="flex-end"
                    >
                      <Button
                        size="small"
                        startIcon={<EditIcon />}
                        onClick={() => navigate(`/edit/${stream.id}`)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        startIcon={<InfoOutlinedIcon />}
                        onClick={() => navigate(`/streams/${stream.id}`)}
                      >
                        Details
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteIcon />}
                        onClick={() => setToDelete(stream)}
                      >
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
