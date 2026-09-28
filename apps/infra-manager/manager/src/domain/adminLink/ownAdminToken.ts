import {
  defaultServicesFor,
  type ManagerAdminLink,
  ownAdminTokenAddressOf,
  sameAdminOrigin,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

/**
 * Every deployment that runs a stream uploader linked to the manager's web2 admin presents a token of its own to
 * the admin (docs/architecture/stages.md, phase 5). The manager generates it at the deploy that first needs it, 64
 * hex characters like every other generated secret, keeps it with them, writes it into the deployment's env file,
 * and pushes its sha256 on the stage record, so the admin knows it before the uploader's first call. A value the
 * deployment stores for `ADMIN_API_TOKEN`, typed or copied from the link by a manager older than this, is written
 * in its place and never replaced. The admin refuses such a token from an uploader since stages phase 9, so the
 * deployment's token is rotated, which takes it out; `docs/features/web2-admin-link.md` says how.
 */

/** The deployment as these rules need it. */
export interface UploaderShape {
  kind: string;
  components?: readonly string[] | null;
}

/** Whether a deployment of this shape runs a stream uploader, which is what reports to the web2 admin. */
export function runsStreamUploader({ kind, components }: UploaderShape): boolean {
  return defaultServicesFor({ kind, components: components ? [...components] : null }).includes(
    STREAM_UPLOADER_SERVICE,
  );
}

/**
 * The address a token of this deployment's own is generated for: the manager's link's, for a deployment that runs
 * a stream uploader, where the link has an address and a token to register the stage with. Null otherwise.
 */
export function ownAdminTokenFor(
  link: Pick<ManagerAdminLink, 'url' | 'tokenStored'> | null | undefined,
  shape: UploaderShape,
): string | null {
  return runsStreamUploader(shape) ? ownAdminTokenAddressOf(link) : null;
}

/**
 * Whether an uploader given the address `url` is given the token of its own: only on the origin it is generated
 * for, the one admin that learns its sha256, so it never goes anywhere else.
 */
export function takesOwnAdminToken(url: string, ownTokenFor: string | null): boolean {
  return ownTokenFor !== null && url !== '' && sameAdminOrigin(url, ownTokenFor);
}
