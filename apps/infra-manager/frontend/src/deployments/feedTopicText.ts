import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

/**
 * The key the viewer's client is built with its topic from. A deployment's own
 * topic sets it through deploy.sh's `--feed-topic`, and one with none is built
 * with what its version sets for the key.
 */
const CLIENT_TOPIC_KEY = 'VITE_APP_RAW_TOPIC';

/** What the stack builds the client with when nothing sets that key, its compose file's fallback. */
export const STACK_FEED_TOPIC = 'swarm-stream';

/**
 * The topic a player follows when its deployment names none: what its
 * version's build sets for the client, or the stack's own fallback where it
 * sets nothing, an empty value included. Null while the version's settings
 * list has not been read.
 */
export function versionFeedTopic(entries: readonly DeploymentSettingEntry[] | null | undefined): string | null {
  if (!entries) return null;
  return entries.find((entry) => entry.key === CLIENT_TOPIC_KEY)?.versionValue || STACK_FEED_TOPIC;
}

/** How a page names the topic of a deployment that sets none, with the topic itself when it is known. */
export function defaultFeedTopicText(versionTopic: string | null): string {
  return versionTopic ? `${versionTopic} (default)` : "the version's default";
}
