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
