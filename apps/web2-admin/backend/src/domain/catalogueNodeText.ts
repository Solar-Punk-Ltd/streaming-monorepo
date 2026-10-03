import type { CatalogueTarget } from './FeedGateway.js';

/** What a gateway error says in place of the catalogue node's address. */
export const CATALOGUE_NODE = 'the catalogue node';

/** Any http or https address, up to the first character no URL in an error message carries. */
const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>()[\]{}]+/gi;

/**
 * A bare address after the network error codes Node puts in front of one: `connect ECONNREFUSED 192.0.2.30:10025`,
 * `getaddrinfo ENOTFOUND bee.example.org`, an IPv6 address in brackets. The code stays, the address goes.
 */
const ADDRESS_AFTER_CODE_PATTERN =
  /\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|EAI_AGAIN|EADDRNOTAVAIL|EPIPE)(\s+)(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(:\d+)?/g;

function replaceAll(text: string, needle: string): string {
  return needle === '' ? text : text.split(needle).join(CATALOGUE_NODE);
}

/**
 * A gateway error without the catalogue node's address in it, for everything that leaves the process: the
 * `publish_error` a stream keeps and the console shows, and the reason an API answer carries. The Bee API address
 * is the one fact about the catalogue node the console is never told, and bee-js and Node both print it in their
 * errors, whole or as `host:port`.
 *
 * Any URL goes first, whole, then any address after a network error code, and last the target's own `host:port`
 * and host name wherever else they appear. In that order, what one step put in is never read by the next. A message
 * about a node the admin wrote to before a new designation is covered by the first two.
 * The log keeps the error as it was: an operator reading it may need the address.
 */
export function withoutCatalogueNode(message: string, target: CatalogueTarget | null = null): string {
  let text = message.replace(URL_PATTERN, CATALOGUE_NODE).replace(ADDRESS_AFTER_CODE_PATTERN, `$1$2${CATALOGUE_NODE}`);
  if (target) {
    try {
      const url = new URL(target.beeApiUrl);
      text = replaceAll(text, url.host);
      // A bare host name is replaced only when it cannot be an ordinary word of the message.
      if (/[.:]/.test(url.hostname)) text = replaceAll(text, url.hostname);
    } catch {
      // A target the contract let through always parses; the patterns above still applied.
    }
  }
  return text;
}
