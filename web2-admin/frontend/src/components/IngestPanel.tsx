import { useState } from 'react';
import {
  Alert,
  Button,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import type { IngestDetails } from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { ConfirmDialog } from './ConfirmDialog';
import { useSnackbar } from './Snackbar';
import { ValueField } from './ValueField';

/** Verbatim from the checkpoint-2 spec; do not paraphrase. */
export const KEY_UNVERIFIED_NOTE =
  'The ingest does not verify this key yet. Anyone with the SRT passphrase ' +
  'can publish under this name until the uploader is upgraded.';

/**
 * The SRT URL and the RTMP stream key both carry `key=<publishKey>`, so both
 * have to be treated as secrets. Only the key is hidden, though: the host,
 * port and stream id are what the operator needs to read back.
 */
function maskPublishKey(value: string): string {
  return value.replace(/key=[^,&?\s]+/g, 'key=••••••••');
}

export function IngestPanel({
  streamId,
  details,
  onRotated,
}: {
  streamId: string;
  details: IngestDetails;
  onRotated: (details: IngestDetails) => void;
}) {
  const snackbar = useSnackbar();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotating, setRotating] = useState(false);

  const rotate = async () => {
    setRotating(true);
    try {
      const next = await api.rotateIngestKey(streamId);
      onRotated(next);
      snackbar.success('Stream key rotated. Update your encoder.');
      setConfirmOpen(false);
    } catch (e) {
      snackbar.error(errorMessage(e, 'Failed to rotate the stream key'));
    } finally {
      setRotating(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            OBS connection details
          </Typography>
          <Button
            size="small"
            color="warning"
            startIcon={<AutorenewIcon />}
            onClick={() => setConfirmOpen(true)}
          >
            Rotate key
          </Button>
        </Stack>

        {!details.keyVerified ? (
          <Alert severity="warning">{KEY_UNVERIFIED_NOTE}</Alert>
        ) : null}

        <Typography variant="subtitle2" color="text.secondary">
          SRT
        </Typography>
        <ValueField
          label="SRT URL"
          value={details.srt.url}
          secret
          maskedValue={maskPublishKey(details.srt.url)}
          helperText="Paste into the OBS Server field. It carries the stream key."
        />
        {details.srt.passphrase ? (
          <ValueField
            label="SRT Passphrase"
            value={details.srt.passphrase}
            secret
            helperText="Server-wide, not per stream. Paste into the OBS Passphrase field."
          />
        ) : (
          <Alert severity="info">
            No SRT passphrase is configured on this ingest server.
          </Alert>
        )}

        <Typography variant="subtitle2" color="text.secondary">
          RTMP
        </Typography>
        <ValueField label="RTMP Server" value={details.rtmp.server} />
        <ValueField
          label="Your stream key"
          value={details.rtmp.streamKey}
          secret
          maskedValue={maskPublishKey(details.rtmp.streamKey)}
          helperText="Paste into the OBS Stream Key field."
        />

        <Typography variant="caption" color="text.secondary">
          Ingest stream id {details.streamId}
          {details.publishKeyRotatedAt
            ? ` · key rotated ${formatDateTime(details.publishKeyRotatedAt)}`
            : ''}
        </Typography>
      </Stack>

      <ConfirmDialog
        open={confirmOpen}
        title="Rotate stream key"
        message="The current key stops working immediately. Any encoder still configured with it will fail to connect until you paste the new one in."
        confirmText={rotating ? 'Rotating…' : 'Rotate key'}
        busy={rotating}
        onConfirm={() => void rotate()}
        onCancel={() => setConfirmOpen(false)}
      />
    </Paper>
  );
}
