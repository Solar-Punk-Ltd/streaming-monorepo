import { useId, type ReactNode } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';

import { MONO_STACK } from '../app/theme';
import { KeyValueList, type KeyValueEntry } from '../components/KeyValueList';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import type { IngestRow } from './ingestCardText';
import { type IngestHealthLoad, ingestHealthView } from './ingestHealthText';
import { RAISE_LATENCY_ACTION, RAISE_LATENCY_BUTTON, type SrtIngestRemedy } from './srtIngestText';

/**
 * How the broadcast coming into SRS held up over the last minute, from the
 * statistics SRS prints into its own log: the SRT link with what to change
 * when it is dropping packets, and the RTMP publishers with the bitrate SRS
 * received from them.
 *
 * Nothing on the broadcaster's side, the manager or the uploader shows packet
 * loss on the way in, and a stream that is breaking up for that reason looks
 * healthy everywhere else on this page. The card only reports: it changes no
 * setting and gates nothing, and its latency step leads to the setting in the
 * deployment's Stack settings card.
 */
export function IngestHealthCard({
  load,
  latencySettingOffered,
  onRaiseLatency,
}: {
  load: IngestHealthLoad;
  latencySettingOffered: boolean;
  /** Brings the SRT latency in the Stack settings card into view, focused. */
  onRaiseLatency: () => void;
}) {
  const view = ingestHealthView(load, { latencySettingOffered });

  return (
    <SectionCard
      title="Ingest"
      sub="the broadcast coming into SRS, over SRT or RTMP"
      actions={<ReadinessPill label={view.pill.label} tone={view.pill.tone} />}
    >
      <Stack spacing={2.5}>
        {view.summary && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {view.summary}
          </Typography>
        )}

        {view.srt && (
          <ProtocolPart title="SRT" summary={view.srt.summary} rows={view.srt.rows}>
            <Typography variant="body2">{view.srt.verdict}</Typography>
            {view.srt.remedy && <Remedy remedy={view.srt.remedy} onRaiseLatency={onRaiseLatency} />}
          </ProtocolPart>
        )}

        {view.rtmp && <ProtocolPart title="RTMP" summary={view.rtmp.summary} rows={view.rtmp.rows} />}
      </Stack>
    </SectionCard>
  );
}

/** One protocol's part of the card, named for screen readers by its heading. */
function ProtocolPart({
  title,
  summary,
  rows,
  children,
}: {
  title: string;
  summary: string;
  rows: IngestRow[];
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <Stack component="section" aria-labelledby={headingId} spacing={1.5}>
      <Typography id={headingId} variant="subtitle2">
        {title}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {summary}
      </Typography>
      {rows.length > 0 && <KeyValueList entries={rows.map(rowEntry)} labelWidth={150} />}
      {children}
    </Stack>
  );
}

function Remedy({ remedy, onRaiseLatency }: { remedy: SrtIngestRemedy; onRaiseLatency: () => void }) {
  return (
    <Alert severity={remedy.severity}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {remedy.title}
      </Typography>
      <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
        {remedy.steps.map((step) => (
          <Box component="li" key={step.text} sx={{ mt: 0.5 }}>
            <Typography variant="body2">{step.text}</Typography>
            {step.action === RAISE_LATENCY_ACTION && (
              <Button size="small" color="inherit" startIcon={<TuneIcon />} onClick={onRaiseLatency} sx={{ mt: 0.5 }}>
                {RAISE_LATENCY_BUTTON}
              </Button>
            )}
          </Box>
        ))}
      </Box>
    </Alert>
  );
}

function rowEntry(row: IngestRow): KeyValueEntry {
  return {
    key: row.label,
    value: (
      <Stack spacing={0.5}>
        <Box component="span" sx={{ fontFamily: MONO_STACK }}>
          {row.value}
        </Box>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
          }}
        >
          {row.detail}
        </Typography>
      </Stack>
    ),
  };
}
