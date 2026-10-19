import { useId, useState, type ReactNode } from 'react';
import { Alert, Button, Paper, Stack, Typography } from '@mui/material';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import SportsScoreIcon from '@mui/icons-material/SportsScore';
import {
  buildObsSrtServer,
  OBS_SRT_PASSPHRASE_FIELD_HELP,
  type IngestDetails,
  type IngestSrtDetails,
  type Stream,
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

/** What Finish does, said before it happens. */
const FINISH_WARNING =
  'Its key changes now, so no encoder can start it again on the old key. To go live on it later on purpose, copy ' +
  'the new SRT line.';

/** Added on a live stream: Finish changes the key and drops no encoder that is already pushing. */
const LIVE_FINISH_WARNING = 'The broadcast carries on until the encoder stops; then it ends for good.';

/** Finish, as the stream page offers it beside Rotate key: on a live or ended stream that is not finished yet. */
export interface FinishOffer {
  /** Whether the stream is live now, about which the confirmation says more. */
  live: boolean;
  /** Called with the stream as the API answers it once finished. Its new details go to `onRotated`. */
  onFinished: (stream: Stream) => void;
}

/**
 * The SRT Server line carries `key=<publishKey>` and, where it can ride there,
 * `passphrase=<passphrase>`. Only those values are hidden: the host, port and stream id
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

export function IngestPanel({
  streamId,
  details,
  onRotated,
  finish = null,
}: {
  streamId: string;
  details: IngestDetails;
  onRotated: (details: IngestDetails) => void;
  /** Offers Finish beside Rotate key. Left out, or null, the panel has no Finish. */
  finish?: FinishOffer | null;
}) {
  const snackbar = useSnackbar();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Read when the dialog opens and kept while it closes: a Finish that worked
  // takes the offer away, and the closing dialog must keep its words.
  const [finishingLive, setFinishingLive] = useState(false);

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

  const askToFinish = (offer: FinishOffer) => {
    setFinishingLive(offer.live);
    setFinishOpen(true);
  };

  // Closed on success only, as Rotate key is: after a failure the operator can
  // try again or cancel.
  const runFinish = async () => {
    setFinishing(true);
    try {
      const answer = await api.finishStream(streamId);
      onRotated(answer.ingest);
      finish?.onFinished(answer.stream);
      snackbar.success('Stream finished. Its key has changed.');
      setFinishOpen(false);
    } catch (e) {
      snackbar.error(errorMessage(e, 'Failed to finish the stream'));
    } finally {
      setFinishing(false);
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
          {finish ? (
            <Button size="small" color="warning" startIcon={<SportsScoreIcon />} onClick={() => askToFinish(finish)}>
              Finish
            </Button>
          ) : null}
        </Stack>

        {details.stage && details.srt ? (
          <>
            <Typography variant="body2">
              On stage <strong>{details.stage.name}</strong>. In OBS, open Settings, then Stream, and set Service to
              Custom. Then copy the SRT values below into OBS. Each field says which box it goes in.
            </Typography>
            {details.stage.retiredAt ? <Alert severity="warning">{RETIRED_STAGE_NOTE}</Alert> : null}

            {/* Streaming uses SRT only. The API still sends `rtmp` for a stage that takes it, and the console leaves it out. */}
            <SrtSettings srt={details.srt} />
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

      <ConfirmDialog
        open={finishOpen}
        title="Finish this stream?"
        message={finishingLive ? `${FINISH_WARNING} ${LIVE_FINISH_WARNING}` : FINISH_WARNING}
        confirmText={finishing ? 'Finishing…' : 'Finish'}
        busy={finishing}
        onConfirm={() => void runFinish()}
        onCancel={() => setFinishOpen(false)}
      />
    </Paper>
  );
}
