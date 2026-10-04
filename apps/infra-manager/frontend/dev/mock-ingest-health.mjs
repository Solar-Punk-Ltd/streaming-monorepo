/**
 * The ingest health route, for the mock manager.
 *
 * It answers in the shape `manager/src/api/routes/ingestHealth.ts` answers,
 * built with the shared rule the manager judges an SRT link by, so the card
 * can be reviewed in every state offline. Both choices stick for a deployment,
 * the way the uploader health's does, because the page asks again every ten
 * seconds and a state that lasted one request would flash and be gone.
 *
 * `?state=` picks the SRT part, or a log that could not be read: `healthy`,
 * `recovered`, `degraded`, `bad`, `no_reports` or `unreadable`.
 * `?rtmp=` picks the RTMP part: `no_reports`, `measured`, `measuring` (a
 * connection SRS has no 30-second bitrate for yet) or `unattributed` (an SRS
 * that does not name the vhost). `?state=no_reports&rtmp=measured` is a
 * broadcast over RTMP alone. A deployment with no srs container answers
 * `not_running` whatever was picked, and one that runs no SRS `not_srs`.
 */
import {
  defaultServicesFor,
  engineOfServices,
  INGEST_NOT_RUNNING,
  INGEST_NOT_SRS,
  INGEST_READ,
  INGEST_UNREADABLE,
  measuredSrtIngest,
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_NO_REPORTS,
  RTMP_INGEST_UNATTRIBUTED,
  SRS_SERVICE,
  SRT_INGEST_NO_REPORTS,
} from '@streaming-infra-manager/common';

import { send } from './mock-http.mjs';

const WINDOW_SECONDS = 60;
const REPORTS_IN_A_MINUTE = 6;

/** A minute of one connection's packets, about what a 6 Mbps broadcast sends. */
const LINKS = {
  healthy: { received: 39_000, lost: 0, retransmitted: 0, dropped: 0 },
  recovered: { received: 39_000, lost: 118, retransmitted: 118, dropped: 0 },
  degraded: { received: 39_000, lost: 212, retransmitted: 190, dropped: 22 },
  // Three times the two reports an outside broadcast printed on 2026-09-22.
  bad: { received: 38_871, lost: 2_283, retransmitted: 2_193, dropped: 2_289 },
};

/** A minute of one RTMP broadcaster, by the bitrate SRS received, or none sampled yet. */
const RTMP_BROADCASTS = {
  measured: 4_812,
  measuring: null,
};

const NO_SRT_REPORTS = SRT_INGEST_NO_REPORTS;
const LOG_UNREADABLE = INGEST_UNREADABLE;
const PICKABLE_SRT = [...Object.keys(LINKS), NO_SRT_REPORTS, LOG_UNREADABLE];
const PICKABLE_RTMP = [...Object.keys(RTMP_BROADCASTS), RTMP_INGEST_NO_REPORTS, RTMP_INGEST_UNATTRIBUTED];

const DEFAULT_SRT = 'healthy';
const DEFAULT_RTMP = RTMP_INGEST_NO_REPORTS;

/** What each deployment was last asked to show, SRT and RTMP apart. */
const pickedSrt = new Map();
const pickedRtmp = new Map();

export function ingestHealthRoutes({ withProfile }) {
  return [
    [
      'GET',
      /^\/profiles\/([^/]+)\/ingest-health$/,
      withProfile((req, res, profile) => send(res, 200, ingestHealthOf(req, profile))),
    ],
  ];
}

function ingestHealthOf(req, profile) {
  const query = new URL(req.url, 'http://mock').searchParams;
  pick(pickedSrt, profile.name, query.get('state'), PICKABLE_SRT);
  pick(pickedRtmp, profile.name, query.get('rtmp'), PICKABLE_RTMP);

  if (engineOfServices(defaultServicesFor(profile)) !== SRS_SERVICE) {
    return { state: INGEST_NOT_SRS, windowSeconds: WINDOW_SECONDS };
  }
  if (!profile.containers.some((container) => container.service === SRS_SERVICE)) {
    return { state: INGEST_NOT_RUNNING, windowSeconds: WINDOW_SECONDS };
  }

  const srt = pickedSrt.get(profile.name) ?? DEFAULT_SRT;
  if (srt === LOG_UNREADABLE) return { state: srt, windowSeconds: WINDOW_SECONDS };
  return {
    state: INGEST_READ,
    windowSeconds: WINDOW_SECONDS,
    srt: srtOf(srt),
    rtmp: rtmpOf(pickedRtmp.get(profile.name) ?? DEFAULT_RTMP),
  };
}

function pick(picked, name, asked, pickable) {
  if (asked && pickable.includes(asked)) picked.set(name, asked);
}

function srtOf(state) {
  if (state === NO_SRT_REPORTS) return { state };
  return measuredSrtIngest({ reports: REPORTS_IN_A_MINUTE, connections: 1, counts: LINKS[state] });
}

function rtmpOf(state) {
  if (!(state in RTMP_BROADCASTS)) return { state };
  return {
    state: RTMP_INGEST_MEASURED,
    reports: REPORTS_IN_A_MINUTE,
    connections: 1,
    incomingKbps: RTMP_BROADCASTS[state],
  };
}
