import { adminTokenProblem, adminUrlProblem } from './managerAdminLink.js';

/**
 * Test connection: the manager asks a web2 admin, from where the manager runs,
 * what the holder of the token would ask it, and answers one of these codes.
 * The manager's own token is the admin's registrar token, proved on the
 * admin's registrar check; an uploader's token is proved on what the uploader
 * asks. The page gives one plain sentence for each. No answer carries anything
 * the admin said, the address or a token.
 */
export const ADMIN_LINK_TEST_OUTCOMES = [
  /**
   * The admin took the token and knows the deployment's stream address as its owner: the owner of the token's stage,
   * or on a token that belongs to no stage, the address it signs its catalog with.
   */
  'linked',
  /**
   * The admin took the token. For the manager's token, the admin's registrar check answered; for an uploader's, there
   * was no stream address to compare its owner with.
   */
  'token-accepted',
  /** The admin took the token but did not say which address it signs with, so the stream address was not compared. */
  'owner-unconfirmed',
  /** The admin took the token but knows another owner for it than the stream address, which the uploader refuses to start with. */
  'owner-mismatch',
  /** A stored token, the manager's or the deployment's own, was saved for another origin, so nothing was asked. */
  'stored-token-elsewhere',
  /** The admin answered and refused the token. */
  'token-refused',
  /**
   * A deployment's token at the address of the manager's link is not one the manager generated for the deployment:
   * typed, copied from the link by an older manager, or set by the version. An admin that takes only a stage's own
   * token refuses it, and an older one still takes it while an upgrade runs; either way the token has to be rotated.
   */
  'token-not-own',
  /**
   * The admin refused the deployment's own token, and the manager has not registered the deployment's stage with it
   * yet, which is how the admin learns that token. A deploy registers it before the uploader starts.
   */
  'token-not-registered',
  /** Something answered at the address, but not as a web2 admin answers. */
  'not-admin',
  /** The address answered with a redirect, which the test does not follow. */
  'redirected',
  /** Nothing answered from where the manager runs, in time or at all. */
  'unreachable',
  /** The address is not an http or https one the uploader could use. */
  'invalid-address',
  /**
   * The address is plain http to another host than the manager's own, which the manager sends its token to only while
   * `ADMIN_LINK_ALLOW_PLAIN_HTTP` is on, so nothing was asked.
   */
  'plain-http-refused',
  /** There is no address, so the uploader runs standalone. */
  'not-linked',
  /** There is an address and no token, which the uploader refuses to start with. */
  'no-token',
] as const;

export type AdminLinkTestOutcome = (typeof ADMIN_LINK_TEST_OUTCOMES)[number];

/** The token a test presents: one typed on the page, or the manager's stored one, which never reaches the page. */
export type AdminLinkTokenChoice = { source: 'stored' } | { source: 'typed'; value: string };

/**
 * Whose token a typed test presents: the web2 admin's registrar token, which the manager's link stores and the
 * Manager settings card tests, or a stream uploader's, which the new-deployment wizard tests for an address the
 * manager's link does not point at. The manager's stored token is the registrar's alone.
 */
export const ADMIN_LINK_TOKEN_HOLDERS = ['registrar', 'uploader'] as const;
export type AdminLinkTokenHolder = (typeof ADMIN_LINK_TOKEN_HOLDERS)[number];

/** What `POST /manager-settings/admin-link/test` takes. */
export interface AdminLinkTestRequest {
  url: string;
  token: AdminLinkTokenChoice;
  /** Whose token it is: the registrar's, left out, or an uploader's, which only a typed token can be. */
  tokenFor?: AdminLinkTokenHolder;
  /**
   * The address the deployment's stream key derives, compared with the owner the admin knows for an uploader's token,
   * where there is one. A registrar's token belongs to no stage, so nothing is compared for one.
   */
  feedOwner?: string | null;
}

/** Said when an uploader's token is asked for with the stored one, which is the registrar's. */
export const STORED_TOKEN_NOT_AN_UPLOADER =
  "The manager's stored token is the web2 admin's registrar token, which no uploader presents. Type the uploader's token to test it.";

/** What both Test connection routes answer. */
export interface AdminLinkTestAnswer {
  outcome: AdminLinkTestOutcome;
}

/** Why this request cannot be tested, one sentence each, or none. No sentence repeats the address or the token. */
export function adminLinkTestProblems({ url, token, tokenFor }: AdminLinkTestRequest): string[] {
  const problems: string[] = [];
  const urlProblem = url === '' ? 'Type the address of the web2 admin to test.' : adminUrlProblem(url);
  if (urlProblem) problems.push(urlProblem);
  if (token.source === 'typed') {
    const tokenProblem =
      token.value === '' ? 'Type a token to test with, or test with the stored one.' : adminTokenProblem(token.value);
    if (tokenProblem) problems.push(tokenProblem);
  } else if (tokenFor === 'uploader') {
    problems.push(STORED_TOKEN_NOT_AN_UPLOADER);
  }
  return problems;
}
