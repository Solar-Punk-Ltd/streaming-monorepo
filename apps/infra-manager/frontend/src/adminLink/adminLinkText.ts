import type { AdminLinkTestOutcome } from '@streaming-infra-manager/common';

/**
 * Everything the web2 admin link says in words, wherever it is set: the
 * Manager settings page, the new-deployment wizard and a deployment's Stack
 * settings card. Each sentence is pinned by a test.
 */

/** One plain sentence for each outcome of Test connection. */
const TEST_TEXT: Readonly<Record<AdminLinkTestOutcome, string>> = {
  linked:
    "Linked: the web2 admin took the token and knows this deployment's stream address as the owner its streams are signed as.",
  'token-accepted': 'The web2 admin answered and took the token.',
  'owner-unconfirmed':
    "The web2 admin took the token but did not say which owner it knows for this deployment, so this deployment's stream key could not be compared.",
  'owner-mismatch':
    "The web2 admin took the token but knows another owner for this deployment than its stream key's address, so the uploader will refuse to start.",
  'stored-token-elsewhere':
    'The stored token was saved for another address, so it was not sent here, and the token has to be typed again for this address.',
  'token-refused': 'The web2 admin answered but refused the token.',
  'token-not-own':
    "This deployment's token is not one the manager generated for it, and the web2 admin on Manager settings takes no other from an uploader, so rotate the uploader's admin token on the deployment page and redeploy.",
  'token-not-registered':
    "The web2 admin does not know this deployment's own token yet, because the manager has not registered the stage with it: a deploy does that before the uploader starts, so deploy or wait for the next push.",
  'not-admin': 'Something answered at this address, but not the way a web2 admin does.',
  redirected: 'This address answered with a redirect, so give the address the web2 admin itself answers on.',
  unreachable: 'The web2 admin did not answer from where the manager runs.',
  'invalid-address': 'This is not an http or https address the uploader can use.',
  'plain-http-refused':
    "This address is plain http to another host than the manager's own, so the manager's token was not sent there: give the https address the web2 admin is served on, or set ADMIN_LINK_ALLOW_PLAIN_HTTP=true on the manager for a test setup.",
  'not-linked': 'This deployment is not linked to a web2 admin, because ADMIN_API_URL is empty.',
  'no-token': 'There is no token to test with, and the uploader refuses to start with an address and no token.',
};

export function adminLinkTestText(outcome: AdminLinkTestOutcome): string {
  return TEST_TEXT[outcome];
}

export type AdminLinkTestSeverity = 'success' | 'info' | 'warning' | 'error';

const QUIET: readonly AdminLinkTestOutcome[] = ['linked', 'token-accepted'];

/** How loudly the page says an outcome: a link that works quietly, an owner not compared as a caution, anything the uploader would fail on as an error. */
export function adminLinkTestSeverity(outcome: AdminLinkTestOutcome): AdminLinkTestSeverity {
  if (QUIET.includes(outcome)) return 'success';
  if (outcome === 'not-linked') return 'info';
  // A token not registered yet is one a deploy registers, not one the admin turned away.
  if (outcome === 'owner-unconfirmed' || outcome === 'token-not-registered') return 'warning';
  return 'error';
}

/** Said beside every Test connection button. */
export const ADMIN_LINK_TEST_REACH =
  "The test runs from where the manager runs, so an address only the deployment's own network can reach reads as unreachable here.";

/** The switch of the new-deployment wizard's Web2 admin group. */
export const ADMIN_LINK_SWITCH_LABEL = 'Link this deployment to the web2 admin';

/** The line at the top of the wizard's Web2 admin group. */
export const ADMIN_LINK_GROUP_LEAD =
  "Where this deployment's stream uploader reports its streams. It starts from the link on Manager settings.";

/** Said under the switch while it is off. */
export const ADMIN_LINK_OFF_NOTE =
  'Off, this deployment stores an empty ADMIN_API_URL, so its uploader runs standalone even when its version turns admin mode on.';

/** Said in place of the group for a version whose settings declare no web2 admin link. */
export const ADMIN_LINK_ABSENT = 'This version takes no web2 admin link, so the uploader runs standalone.';

/** Said in the group and on the review when the manager's own link could not be read and the operator left the group alone. */
export const ADMIN_LINK_MANAGER_UNREAD =
  "The manager's link could not be read here, so the manager links this deployment itself where it has a link.";

/** Said in the group while the manager's own link is read. */
export const ADMIN_LINK_MANAGER_READING = "Reading the manager's link.";

/** Said in place of the group when the version's settings could not be read. */
export const ADMIN_LINK_UNREAD =
  "This version's settings could not be read, so the deployment starts with the manager's link where its version takes one, and otherwise keeps what its version sets.";

/** The wizard's choice of a token of the deployment's own. */
export const OWN_TOKEN_TITLE = 'A token of its own';

/** What that choice says, which depends on whether the manager's link can register one. */
export function ownTokenDetail(available: boolean): string {
  return available
    ? "This deployment gets a token of its own: the manager generates it at the first deploy and registers it with the web2 admin before the uploader starts. It never reaches this page, and Test connection uses the manager's stored token."
    : 'The manager has no web2 admin link with a token to register one with. Save the link on Manager settings, or type a token here.';
}

/** Said in the wizard's group when the address leaves the origin of the manager's link while a token of its own is chosen. */
export const OWN_TOKEN_ELSEWHERE =
  'A token of its own is registered only with the web2 admin on Manager settings, and this address is another one. Type the token for this address.';

/**
 * Said in the wizard's group when a token typed here is chosen at the address of the manager's link, whose web2 admin
 * takes only a token of the deployment's own from an uploader. The manager refuses such a save or create with it.
 */
export { TYPED_TOKEN_AT_LINK } from '@streaming-infra-manager/common';

/** The button beside that sentence, which moves back to a token of its own. */
export const USE_OWN_TOKEN = 'Use a token of its own';

/** What the wizard's choice of a token typed here says: it is for another admin than the manager's own. */
export const TYPED_TOKEN_DETAIL =
  'For a web2 admin other than the one on Manager settings: the token it takes from this uploader, at least 32 characters.';

/** The button beside that sentence, which moves to a token typed here. */
export const TYPE_TOKEN_HERE = 'Type a token for this address';

/** The line at the top of the Manager settings card. */
export const MANAGER_LINK_LEAD =
  'New uploader deployments start linked to this web2 admin, with the switch on in the new-deployment wizard. The manager pushes the stage of every deployment linked to this admin to this address with this token, so a new token is used at the next push. A deployment keeps the address it was created with, so an address of another admin here stops its pushes.';

export const MANAGER_LINK_URL_HINT =
  'Where the uploaders reach the web2 admin. Leave it empty for no default, which takes the stored token out too.';

export const MANAGER_LINK_SAVED = 'Saved. New uploader deployments start with this link.';

export const MANAGER_LINK_SAVE_RACE =
  'The link changed elsewhere after this page read it, so nothing was saved. The page has read it again. Make your change again.';

/** Where the manager's token stands, in place of the token, which is never shown. */
export function managerTokenStatus(stored: boolean, clearing: boolean): string {
  if (clearing) return 'The stored token is taken out when you save.';
  return stored ? 'A token is stored. It is never shown.' : 'No token is stored.';
}

/** The line under the manager's token field. */
export function managerTokenHint(stored: boolean): string {
  const what = "The web2 admin's INTERNAL_API_TOKEN, at least 32 characters.";
  return stored ? `${what} Leave it empty to keep the stored one.` : what;
}

/** Why the Manager settings card cannot test yet. */
export function managerLinkTestBlocked(facts: { problems: boolean; url: boolean; tokenStored: boolean }): string {
  if (facts.problems) return 'Fix the address or the token above to test it.';
  if (!facts.url) return 'Type the address to test it.';
  return facts.tokenStored ? 'Type a token, or keep the stored one, to test it.' : 'Type a token to test it.';
}
