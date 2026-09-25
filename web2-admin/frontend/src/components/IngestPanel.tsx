import { useId, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import {
  buildObsSrtServer,
  type IngestDetails,
} from '@streaming-monorepo/web2-admin-common';

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
 * The SRT Server line carries `key=<publishKey>` and, where it can ride there,
 * `passphrase=<passphrase>`. The RTMP stream key carries the same `key=`. Only
 * those values are hidden: the host, port and stream id are what the operator
 * needs to read back. A value ends at a comma because the SRT stream id carries
 * `,m=publish` after the key.
 */
function maskIngestSecrets(value: string): string {
  return value.replace(/\b(key|passphrase)=[^,&?\s]+/g, '$1=••••••••');
}

/** One protocol's settings, named for screen readers by its heading. */
function ProtocolSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Stack component="section" aria-labelledby={headingId} spacing={2}>
      <Typography id={headingId} variant="subtitle2" color="text.secondary">
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

function SrtSettings({ srt }: { srt: IngestDetails['srt'] }) {
  const { server, passphraseRoute } = buildObsSrtServer(
    srt.url,
    srt.passphrase,
  );
  return (
    <ProtocolSection title="SRT">
      <ValueField
        label="SRT Server"
        value={server}
        secret
        maskedValue={maskIngestSecrets(server)}
        helperText={
          passphraseRoute === 'server'
            ? 'Paste into the Server box. It carries the stream id, your key and the passphrase.'
            : 'Paste into the Server box. It carries the stream id and your key.'
        }
      />
      <Typography variant="body2">
        <strong>Stream Key</strong>: leave it empty. The Server line already
        names the stream.
      </Typography>
      {passphraseRoute === 'authentication' && srt.passphrase ? (
        <ValueField
          label="SRT Password"
          value={srt.passphrase}
          secret
          helperText="This passphrase has characters the Server line cannot carry. In OBS, tick Use authentication, leave Username empty and paste this into Password."
        />
      ) : null}
      {passphraseRoute === 'none' ? (
        <Alert severity="info">
          No SRT passphrase is configured on this ingest server.
        </Alert>
      ) : null}
    </ProtocolSection>
  );
}

function RtmpSettings({ rtmp }: { rtmp: IngestDetails['rtmp'] }) {
  return (
    <ProtocolSection title="RTMP">
      <ValueField
        label="RTMP Server"
        value={rtmp.server}
        helperText="Paste into the Server box."
      />
      <ValueField
        label="RTMP Stream Key"
        value={rtmp.streamKey}
        secret
        maskedValue={maskIngestSecrets(rtmp.streamKey)}
        helperText="Paste into the Stream Key box."
      />
    </ProtocolSection>
  );
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

        <Typography variant="body2">
          In OBS, open Settings, then Stream, and set Service to Custom. Then
          pick one of the two protocols below and copy its values into OBS.
          Each field says which box it goes in.
        </Typography>

        <SrtSettings srt={details.srt} />
        <RtmpSettings rtmp={details.rtmp} />

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
