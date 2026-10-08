/**
 * The wait the player ships with, named so that something can run it.
 *
 * As an inline default parameter it was the one code path every backoff test injected over, so a
 * default that returned immediately left the whole suite green while a page of players hammered a
 * gateway that was already down.
 */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
