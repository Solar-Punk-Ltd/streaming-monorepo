import { PrivateKey, Topic } from '@ethersphere/bee-js';

/**
 * Who this backend is on Swarm. `owner` is the feed key's Ethereum address as
 * lowercase hex without `0x` — the form that appears in bee's
 * `/feeds/<owner>/<topic>` URLs and in the feed entries msrs-client wrote.
 */
export interface FeedIdentity {
  owner: string;
  /** The raw (pre-hash) topic, e.g. `swarm-stream`. */
  topic: string;
  /** Its keccak256, as bee URLs take it. */
  topicHex: string;
}

export function feedIdentityFrom(feedPrivateKey: string, feedTopic: string): FeedIdentity {
  const owner = new PrivateKey(feedPrivateKey).publicKey().address().toString();
  return {
    owner,
    topic: feedTopic,
    topicHex: Topic.fromString(feedTopic).toString(),
  };
}

/**
 * An address in the form a stream's `owner` is kept in: lower case and without `0x`, as `feedIdentityFrom` writes
 * the brand key's. A stage record carries its owner with `0x`, and a stream on that stage takes it in this form, so
 * every entry on the catalogue names its owner one way.
 */
export function asFeedOwner(address: string): string {
  return address.trim().toLowerCase().replace(/^0x/, '');
}
