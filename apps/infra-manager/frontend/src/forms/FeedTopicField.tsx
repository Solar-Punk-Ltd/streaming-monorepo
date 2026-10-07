import { TextField } from '@mui/material';

import { MONO_STACK } from '../app/theme';
import { STACK_FEED_TOPIC } from '../deployments/feedTopicText';
import { FormField, messageIdFor } from './FormField';
import { feedTopicProblem } from './validation';

const HINT = `Leave empty for the stack version's own topic, ${STACK_FEED_TOPIC} unless the version sets another.`;

/**
 * The topic a player follows, asked beside the streamer whose feed it is, in
 * the wizard and in both Edit drawers.
 *
 * Optional, because a player with none follows its stack version's own topic,
 * and checked as it is typed against the rule the manager and the stack's
 * deploy script hold it to, so a topic either would refuse never leaves the form.
 */
export function FeedTopicField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const error = feedTopicProblem(value);

  return (
    <FormField label="Feed topic" aside="optional" hint={HINT} error={error} htmlFor={id}>
      <TextField
        id={id}
        size="small"
        fullWidth
        error={error !== null}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        slotProps={{
          htmlInput: { 'aria-describedby': messageIdFor(id), style: { fontFamily: MONO_STACK } },
        }}
      />
    </FormField>
  );
}
