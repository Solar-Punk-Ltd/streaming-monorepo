/**
 * Feed topic rules, shared by the manager's request schemas and the UI's
 * inline validation so both refuse exactly the same values.
 *
 * The shape is the stack's own. The manager hands the topic to the stack's
 * deploy script as `--feed-topic=<value>`, and _lib.sh's
 * require_override_shape refuses the flag outside this pattern, so a topic
 * accepted here and refused there would be a deployment no deploy can run.
 * Migration 033 holds the column to the same shape.
 */
export const FEED_TOPIC_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The shape in the words the deploy script refuses the flag with. */
export const FEED_TOPIC_MESSAGE = 'must be letters, digits, dot, underscore or hyphen, at most 64 characters';
