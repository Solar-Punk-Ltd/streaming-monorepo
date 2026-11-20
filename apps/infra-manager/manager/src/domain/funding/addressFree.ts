/**
 * What the admin reads of a sentence a port, a stage's Apply or a node wrote, with every node address in it left out:
 * a URL, a host and its port, and an IP address, v4 or v6, with its port, each become {@link ADDRESS_LEFT_OUT}. The
 * admin is told why a purchase stopped, never where a node is; the manager's log keeps the sentence whole.
 */
export const ADDRESS_LEFT_OUT = '<address>';

/** A URL: a scheme and `://`, up to a space or a quote, less the punctuation that ends a sentence around it. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*[^\s"'<>.,;:!?)\]}]/gi;

/** An IPv6 address in brackets, as a URL or a host and port carries one, with its port. */
const BRACKETED_IPV6_RE = /\[[0-9a-f.]*:[0-9a-f:.]*\](?::\d{1,5})?/gi;

/** An IPv4 address, with its port. */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;

/** An IPv6 address without brackets: all eight groups, or fewer around a `::`. A time of day has neither. */
const IPV6_RE =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![\w:])/gi;

/**
 * A host name and its port: a name that begins with a letter, then a colon and the port. A version (`uploader:1.4.2`)
 * and an image tag (`postgres:16-alpine`) go on past the digits, and are kept.
 */
const HOST_PORT_RE = /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*:\d{1,5}(?![\w-]|\.\w)/gi;

/** The sentence with every node address in it left out, and the rest as written. */
export function addressFree(text: string): string {
  return text
    .replace(URL_RE, ADDRESS_LEFT_OUT)
    .replace(BRACKETED_IPV6_RE, ADDRESS_LEFT_OUT)
    .replace(IPV4_RE, ADDRESS_LEFT_OUT)
    .replace(IPV6_RE, ADDRESS_LEFT_OUT)
    .replace(HOST_PORT_RE, ADDRESS_LEFT_OUT);
}
