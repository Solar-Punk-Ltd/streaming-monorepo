import {
  BEE_UPLOADER_SERVICE,
  buildObsSrtServer,
  buildSrtPublishUrl,
  CLIENT_SERVICE,
  defaultServicesFor,
  isPublicPortVar,
  OME_SERVICE,
  SRS_SERVICE,
  type ObsSrtServer,
} from '@streaming-infra-manager/common';

import type { Profile } from './types';

const LOCAL_HOSTS = new Set(['', 'localhost', '0.0.0.0', '127.0.0.1', 'native']);

/**
 * The address to dial for a deployment's components.
 *
 * `profile.host` is a *deploy* target, so it may be an ssh alias: a key into
 * the manager's ssh config and nothing a browser can resolve. `network_host` is
 * that target already resolved server-side, so prefer it and keep `host` only as
 * the fallback for a manager that does not send it yet.
 */
export function hostFor(profile: Profile, serverHost: string): string {
  const profileHost = profile.network_host?.trim() || profile.host?.trim() || '';
  if (!LOCAL_HOSTS.has(profileHost)) return profileHost;
  return serverHost || window.location.hostname;
}

export function componentUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function clientUrl(profile: Profile, serverHost: string): string | null {
  const client = profile.containers.find((c) => c.service === CLIENT_SERVICE);
  if (!client) return null;
  const port = client.ports.CLIENT_PORT;
  if (!port) return null;
  return componentUrl(hostFor(profile, serverHost), port);
}

/** The API of this deployment's own Bee node, when it runs one. */
export function beeApiUrl(profile: Profile, serverHost: string): string | null {
  const bee = profile.containers.find((c) => c.service === BEE_UPLOADER_SERVICE);
  const port = bee?.ports.BEE_UPLOADER_API_PORT;
  if (!port) return null;
  return componentUrl(hostFor(profile, serverHost), port);
}

/** The application and stream a publish address names until the operator gives their own. */
const DEFAULT_APP = 'live';
const DEFAULT_STREAM = 'stream';
const SRT_DEFAULT_APP_STREAM = `${DEFAULT_APP}/${DEFAULT_STREAM}`;
const SRS_SRT_BASE_PORT = 10001;
const SRS_RTMP_BASE_PORT = 10002;
const OME_SRT_BASE_PORT = 10001;
const OME_DEFAULT_APP_STREAM = 'video/stream';

/**
 * What OBS's Server box takes for this deployment, and where its passphrase goes.
 *
 * `passphrase` is the one this deployment publishes under, already decided by
 * `publishPassphrase`: its own where it holds one, otherwise the host-wide
 * SRT_PASSPHRASE from `GET /config`, which is the precedence the deploy
 * applies when it writes `.env.<profile>`. It is passed in rather than read off
 * the profile because the row does not carry it, and reading it costs a request
 * that only a page about to show or copy the URL should make. Only SRS reads a
 * passphrase. OME's SRT listener has none.
 */
export function srtPublishSettings(
  profile: Profile,
  serverHost: string,
  passphrase?: string | null,
): ObsSrtServer | null {
  const host = hostFor(profile, serverHost);
  // The kind's default services count too: a viewer stores no components list,
  // and reading only the stored list handed every viewer an SRT URL for a port
  // nothing listens on.
  const services = defaultServicesFor(profile);

  const ome = profile.containers.find((c) => c.service === OME_SERVICE);
  if (ome || services.includes(OME_SERVICE)) {
    const port = ome?.ports.OME_SRT_PORT ?? (profile.port_slot > 0 ? OME_SRT_BASE_PORT + profile.port_slot * 10 : null);
    if (!port) {
      return null;
    }

    return {
      server: `srt://${host}:${port}?streamid=srt://${host}:${port}/${OME_DEFAULT_APP_STREAM}`,
      passphraseRoute: 'none',
    };
  }

  const srs = profile.containers.find((c) => c.service === SRS_SERVICE);
  if (!srs && !services.includes(SRS_SERVICE)) {
    return null;
  }
  const port = srs?.ports.SRS_SRT_PORT ?? (profile.port_slot > 0 ? SRS_SRT_BASE_PORT + profile.port_slot * 10 : null);
  if (!port) return null;
  const base = buildSrtPublishUrl({ host, srtPort: port }, SRT_DEFAULT_APP_STREAM);
  return buildObsSrtServer(base, passphrase?.trim() || null);
}

/** The line a publisher points OBS or FFmpeg at, carrying the passphrase only where it can. */
export function srtPublishUrl(profile: Profile, serverHost: string, passphrase?: string | null): string | null {
  return srtPublishSettings(profile, serverHost, passphrase)?.server ?? null;
}

/** OBS's two RTMP boxes for a deployment. */
export interface RtmpPublishSettings {
  /** What goes in OBS's Server box. */
  server: string;
  /** What goes in OBS's Stream Key box, which OBS publishes as the RTMP stream name. */
  streamKey: string;
}

/**
 * OBS's RTMP boxes for an SRS deployment, naming the same application and
 * stream as its SRT line, or null where the deployment takes no RTMP. RTMP has
 * no passphrase, so nothing secret is read or carried. OvenMediaEngine takes
 * SRT alone, so it has none, and SRS offers RTMP only where the port policy
 * opens its port, which it does not by default: an address the firewall turns
 * away is not offered.
 *
 * @param rtmpOpen whether the port policy opens SRS's RTMP port, read from the policy unless a test says otherwise
 */
export function rtmpPublishSettings(
  profile: Profile,
  serverHost: string,
  rtmpOpen: boolean = isPublicPortVar('SRS_RTMP_PORT'),
): RtmpPublishSettings | null {
  if (!rtmpOpen) return null;
  const services = defaultServicesFor(profile);
  // OvenMediaEngine first, as srtPublishSettings decides it, so a record left from SRS offers nothing.
  if (profile.containers.some((c) => c.service === OME_SERVICE) || services.includes(OME_SERVICE)) return null;
  const srs = profile.containers.find((c) => c.service === SRS_SERVICE);
  if (!srs && !services.includes(SRS_SERVICE)) return null;
  const port = srs?.ports.SRS_RTMP_PORT ?? (profile.port_slot > 0 ? SRS_RTMP_BASE_PORT + profile.port_slot * 10 : null);
  if (!port) return null;
  return { server: `rtmp://${hostFor(profile, serverHost)}:${port}/${DEFAULT_APP}`, streamKey: DEFAULT_STREAM };
}
