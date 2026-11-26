import { useId, useState, type ReactNode } from 'react';
import { Alert, Box, Button, ButtonBase, Collapse, Paper, Stack, Typography } from '@mui/material';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  buildObsSrtServer,
  OBS_SRT_PASSPHRASE_FIELD_HELP,
  rtmpUnencryptedWarning,
  type IngestDetails,
  type IngestRtmpDetails,
  type IngestSrtDetails,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { errorMessage } from '../errors';
import { formatDateTime } from '../dateUtil';
import { ConfirmDialog } from './ConfirmDialog';
import { useSnackbar } from './Snackbar';
import { ValueField } from './ValueField';

/** What the panel says while the stream has no stage, so there is nowhere to send it yet. */
export const NO_STAGE_NOTE = 'Pick the stage this stream is broadcast on, in its edit form, to see where OBS sends it.';

/** What the panel says under the details of a stage the manager retired. */
export const RETIRED_STAGE_NOTE =
  'The manager retired this stage. These are the details it last pushed, and they may no longer answer.';

/** What the intro adds on a stage that takes RTMP. */
export const RTMP_INTRO_NOTE = 'For an encoder that cannot send SRT, RTMP is under Other protocols.';

/** What the panel says beside RTMP, in the words every console uses, for a stage with or without an SRT passphrase. */
export function rtmpUnencryptedNote(hasSrtPassphrase: boolean): string {
  return rtmpUnencryptedWarning('stage', hasSrtPassphrase);
}

/**
 * The SRT Server line carries `key=<publishKey>` and, where it can ride there,
 * `passphrase=<passphrase>`. The RTMP stream key, where RTMP is offered, carries
 * the same `key=`. Only those values are hidden: the host, port and stream id
 * are what the operator needs to read back. A value ends at a comma because the
 * SRT stream id carries `,m=publish` after the key.
 */
function maskIngestSecrets(value: string): string {
  return value.replace(/\b(key|passphrase)=[^,&?\s]+/g, '$1=••••••••');
}

/** One protocol's settings, named for screen readers by its heading. */
function ProtocolSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Stack component="section" aria-labelledby={headingId} spacing={2}>
      <Typography id={headingId} variant="subtitle2" sx={{ color: 'text.secondary' }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/**
 * OBS's SRT boxes: the Server line from `buildObsSrtServer`, which leaves the
 * Stream Key box empty, and the Use authentication Password when the
 * passphrase cannot ride on that line.
 */
function SrtSettings({ srt }: { srt: IngestSrtDetails }) {
  const { server, passphraseRoute } = buildObsSrtServer(srt.url, srt.passphrase);
  return (
    <ProtocolSection title="SRT Connection">
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
        <strong>Stream Key</strong>: leave it empty. The Server line already names the stream.
      </Typography>
      {passphraseRoute === 'authentication' && srt.passphrase ? (
        <ValueField label="SRT Password" value={srt.passphrase} secret helperText={OBS_SRT_PASSPHRASE_FIELD_HELP} />
      ) : null}
      {passphraseRoute === 'none' ? (
        <Alert severity="info">No SRT passphrase is configured on this stage.</Alert>
      ) : null}
    </ProtocolSection>
  );
}

/**
 * OBS's RTMP boxes. OBS publishes the Stream Key box as the RTMP stream name,
 * so the key rides on it as `<topic>?key=<key>`.
 */
function RtmpSettings({ rtmp, hasSrtPassphrase }: { rtmp: IngestRtmpDetails; hasSrtPassphrase: boolean }) {
  return (
    <ProtocolSection title="RTMP">
      <Alert severity="warning">{rtmpUnencryptedNote(hasSrtPassphrase)}</Alert>
      <ValueField label="RTMP Server" value={rtmp.server} helperText="Paste into the Server box." />
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

/**
 * The protocols after SRT, folded each time the panel opens. The heading holds
 * the button, the disclosure pattern a screen reader announces as a heading
 * that expands. A folded section renders nothing inside it, so no RTMP key is
 * in the page until it is opened.
 */
function OtherProtocols({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const contentId = useId();
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ borderTop: 1, borderColor: 'divider' }}>
      <Typography id={headingId} variant="subtitle2" component="h3" sx={{ m: 0 }}>
        <ButtonBase
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', py: 1.25, gap: 1, borderRadius: 1 }}
        >
          <ExpandMoreIcon
            fontSize="small"
            sx={{ flex: 'none', transition: 'transform 150ms', transform: open ? 'rotate(180deg)' : 'none' }}
          />
          Other protocols
        </ButtonBase>
      </Typography>
      <Collapse in={open} unmountOnExit>
        <Stack id={contentId} spacing={2} sx={{ pb: 1 }}>
          {children}
        </Stack>
      </Collapse>
    </Box>
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
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            OBS connection details
          </Typography>
          <Button size="small" color="warning" startIcon={<AutorenewIcon />} onClick={() => setConfirmOpen(true)}>
            Rotate key
          </Button>
        </Stack>

        {details.stage && details.srt ? (
          <>
            <Typography variant="body2">
              On stage <strong>{details.stage.name}</strong>. In OBS, open Settings, then Stream, and set Service to
              Custom. Then copy the SRT values below into OBS. Each field says which box it goes in.
              {details.rtmp ? ` ${RTMP_INTRO_NOTE}` : null}
            </Typography>
            {details.stage.retiredAt ? <Alert severity="warning">{RETIRED_STAGE_NOTE}</Alert> : null}

            <SrtSettings srt={details.srt} />
            {/* The API sends `rtmp` only for a stage that takes it, an SRS stage. Its settings stay folded under Other protocols. */}
            {details.rtmp ? (
              <OtherProtocols>
                <RtmpSettings rtmp={details.rtmp} hasSrtPassphrase={Boolean(details.srt.passphrase)} />
              </OtherProtocols>
            ) : null}
          </>
        ) : (
          <Alert severity="info">{NO_STAGE_NOTE}</Alert>
        )}

        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Ingest stream id {details.streamId}
          {details.publishKeyRotatedAt ? ` · key rotated ${formatDateTime(details.publishKeyRotatedAt)}` : ''}
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
