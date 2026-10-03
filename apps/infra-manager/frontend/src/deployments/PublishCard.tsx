import { Alert, Stack, Typography } from '@mui/material';

import { OBS_SRT_PASSPHRASE_FIELD_HELP, OME_SERVICE } from '@streaming-infra-manager/common';

import { CopyBox } from '../components/CopyBox';
import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';
import type { RtmpPublishSettings } from '../urls';
import { engineOf } from './shape';
import { deploymentProgressText } from './deploymentPhase';
import {
  OBS_SERVER_BOX,
  OBS_STREAM_KEY_BOX,
  publishesWithSrtPassphrase,
  RTMP_BOXES_NOTE,
  rtmpUnencryptedWarning,
} from './publishText';

/**
 * Which passphrase is already baked into the URL on screen.
 *
 * The host-wide one is a fallback that may not exist: a host with no
 * SRT_PASSPHRASE publishes in the clear, and saying "encrypted" there would be
 * the one sentence on this page that is not true.
 */
function passphraseNote(profile: Profile, hostPassphrase: string | null, inTheUrl: boolean): string {
  if (engineOf(profile) === OME_SERVICE) {
    return 'OvenMediaEngine ingest. Its SRT listener takes no passphrase.';
  }
  const where = inTheUrl ? 'already in the URL' : "for OBS's own passphrase field below";
  if (profile.has_srt_passphrase) {
    return `Encrypted with this deployment's own passphrase, ${where}.`;
  }
  return hostPassphrase
    ? `Encrypted with the host-wide passphrase, ${where}. Set a passphrase of its own under Edit.`
    : 'This host has no shared passphrase, so the ingest is unencrypted. Set one for this deployment under Edit.';
}

export function PublishCard({
  profile,
  url,
  hostPassphrase,
  ready,
  passphrasePending,
  fieldPassphrase = null,
  rtmp = null,
}: {
  profile: Profile;
  url: string;
  hostPassphrase: string | null;
  /** Whether all currently observed prerequisites pass the checklist. */
  ready: boolean;
  /** Whether the URL still lacks this profile revision's own passphrase. */
  passphrasePending: boolean;
  /** The passphrase the URL cannot carry, for OBS's own field. */
  fieldPassphrase?: string | null;
  /** OBS's RTMP boxes, for a deployment whose engine takes RTMP. */
  rtmp?: RtmpPublishSettings | null;
}) {
  return (
    <SectionCard title="Publish" sub={rtmp ? 'OBS, FFmpeg or any SRT or RTMP sender' : 'OBS, FFmpeg or any SRT sender'}>
      <Stack spacing={1.25}>
        <Alert severity={ready ? 'info' : 'warning'}>{deploymentProgressText(profile)}</Alert>
        {rtmp && <Typography variant="subtitle2">SRT</Typography>}
        <CopyBox value={url} disabled={passphrasePending} />
        {passphrasePending && (
          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
            }}
          >
            Reading this deployment&apos;s passphrase. Copy is available when the complete URL is ready.
          </Typography>
        )}
        {fieldPassphrase && (
          <>
            <CopyBox value={fieldPassphrase} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {OBS_SRT_PASSPHRASE_FIELD_HELP}
            </Typography>
          </>
        )}
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
          }}
        >
          {!passphrasePending && <>{passphraseNote(profile, hostPassphrase, !fieldPassphrase)} </>}
          Change <code>live/stream</code> to your own app and stream name if you use one.
        </Typography>
        {rtmp && <RtmpPart rtmp={rtmp} hasSrtPassphrase={publishesWithSrtPassphrase(profile, hostPassphrase)} />}
      </Stack>
    </SectionCard>
  );
}

/** OBS's RTMP boxes, which carry no passphrase because RTMP has none, with what that costs. */
function RtmpPart({ rtmp, hasSrtPassphrase }: { rtmp: RtmpPublishSettings; hasSrtPassphrase: boolean }) {
  return (
    <>
      <Typography variant="subtitle2" sx={{ pt: 1 }}>
        RTMP
      </Typography>
      <Alert severity="warning">{rtmpUnencryptedWarning(hasSrtPassphrase)}</Alert>
      <BoxLabel>{OBS_SERVER_BOX}</BoxLabel>
      <CopyBox value={rtmp.server} />
      <BoxLabel>{OBS_STREAM_KEY_BOX}</BoxLabel>
      <CopyBox value={rtmp.streamKey} />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {RTMP_BOXES_NOTE}
      </Typography>
    </>
  );
}

function BoxLabel({ children }: { children: string }) {
  return (
    <Typography variant="caption" sx={{ color: 'text.secondary', mb: -0.75 }}>
      {children}
    </Typography>
  );
}
