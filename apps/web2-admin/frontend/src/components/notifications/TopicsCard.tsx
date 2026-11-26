import { useState } from 'react';
import {
  Alert,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import {
  NOTICE_TOPIC_GROUPS,
  NOTICE_TOPIC_NAMES,
  noticePeople,
  storedNoticeTopics,
  type NoticesView,
  type NoticeTopic,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { noticesReachMe, reachText } from './noticeText';

/** What each topic's notices tell of, under its tick, as `docs/architecture/notifications.md` lists them. */
const TOPIC_TEXTS: Readonly<Record<NoticeTopic, string>> = {
  topups_coming: 'Top-ups of marked stamps, a day ahead.',
  wallet_low: "The brand wallet's xBZZ or xDAI under what the top-ups need.",
  topup_failed: 'A due marked stamp that could not be topped up.',
  stamp_expired: 'A marked stamp that ran out.',
  unmarked_catalogue: 'The catalogue batch or an archive stamp, not on auto top-up, running low.',
  unmarked_stage: "A stage's batch, not on auto top-up, running low.",
};

/** A line under a group of topics, where the group needs one. */
const GROUP_NOTES: Readonly<Record<string, string>> = {
  'Stamps not on auto top-up':
    "A stage's batch runs out by design after its event, so tick Stage stamps for the stages that are meant to last.",
};

/**
 * The notices the signed-in user gets: a tick per topic, grouped as `NOTICE_TOPIC_GROUPS` groups them, each with what
 * it tells of and how many people get it. A tick is saved at once, with no password, as the whole list. A user who
 * saved no destination and no tick gets the four topics of stamp auto top-up ticked by their first saved destination.
 */
export function TopicsCard({ view, onView }: { view: NoticesView; onView: (next: NoticesView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticked = new Set<NoticeTopic>(view.topics);
  const hasDestination = view.destinations.some((destination) => destination.address !== null);

  const tick = async (topic: NoticeTopic, on: boolean) => {
    const next = storedNoticeTopics(on ? [...view.topics, topic] : view.topics.filter((each) => each !== topic));
    setBusy(true);
    setError(null);
    try {
      onView(await api.saveMyNoticeTopics(next));
    } catch (e: unknown) {
      setError(errorMessage(e, 'Your notices could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-section>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          The notices I get
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Tick the notices you want. A tick is saved at once, with no password, and beside each is how many people get
          it.
        </Typography>
        {!hasDestination && view.topics.length === 0 ? (
          <Typography variant="body2">
            Your first saved email address or Telegram chat ticks the four notices of stamp auto top-up for you.
          </Typography>
        ) : null}
        {view.topics.length > 0 && !noticesReachMe(view) ? (
          <Typography variant="body2" sx={{ color: 'warning.main' }}>
            None of your destinations is on, on a service that is on, so no notice reaches you now.
          </Typography>
        ) : null}
        {error ? (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {NOTICE_TOPIC_GROUPS.map((group) => (
          <FormControl key={group.name} component="fieldset" variant="standard">
            <FormLabel component="legend" sx={{ mb: 0.5 }}>
              {group.name}
            </FormLabel>
            {GROUP_NOTES[group.name] ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {GROUP_NOTES[group.name]}
              </Typography>
            ) : null}
            <FormGroup>
              {group.topics.map((topic) => {
                const describedBy = `notifications-topic-${topic}-text`;
                return (
                  <Stack key={topic} sx={{ mt: 0.5 }}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={ticked.has(topic)}
                          disabled={busy}
                          onChange={(event) => void tick(topic, event.target.checked)}
                          slotProps={{ input: { 'aria-describedby': describedBy } }}
                        />
                      }
                      label={NOTICE_TOPIC_NAMES[topic]}
                    />
                    <Typography id={describedBy} variant="caption" sx={{ color: 'text.secondary', pl: 4 }}>
                      {`${TOPIC_TEXTS[topic]} ${reachText(noticePeople(view, topic))}.`}
                    </Typography>
                  </Stack>
                );
              })}
            </FormGroup>
          </FormControl>
        ))}
      </Stack>
    </Paper>
  );
}
