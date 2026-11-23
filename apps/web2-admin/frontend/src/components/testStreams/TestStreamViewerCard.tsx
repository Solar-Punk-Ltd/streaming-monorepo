import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  storedViewerUrl,
  viewerUrlProblem,
  watchPageUrl,
  type PublicConfig,
  type Stream,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { monoFont } from '../../theme/createAdminTheme';
import { useSnackbar } from '../Snackbar';
import { ValueField } from '../ValueField';

/** What the deploy section says above the two values. */
export const DEPLOY_A_VIEWER =
  'Deploy a viewer with these two values in the manager’s “Watch a stream”, then give its address below. They are ' +
  'the same for every test stream.';

/** Under the address field while it holds nothing refused. */
export const VIEWER_ADDRESS_HELP = 'The deployed viewer’s address: any http:// or https:// one, with a port or a path.';

/** A section of the card, named for screen readers by its heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Stack component="section" aria-labelledby={headingId} spacing={1.5}>
      <Typography id={headingId} variant="subtitle2">
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/**
 * How the team watches a test stream: the two values to deploy a viewer with in the manager, the field that gives and
 * changes that viewer's address, and once one is given, "Watch test stream", a plain link to the stream's watch page
 * on that viewer, opened in a new tab. The console never asks the viewer whether it answers.
 */
export function TestStreamViewerCard({
  stream,
  feed,
  onSaved,
}: {
  stream: Stream;
  /** The catalogue's owner and topic, or null while `GET /api/config` is unread. */
  feed: PublicConfig['feed'] | null;
  onSaved: (stream: Stream) => void;
}) {
  const snackbar = useSnackbar();
  const [value, setValue] = useState(stream.viewerUrl ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The field follows the address the stream holds: after a save, and when the page reads the stream again.
  useEffect(() => {
    setValue(stream.viewerUrl ?? '');
    setProblem(null);
  }, [stream.id, stream.viewerUrl]);

  const save = async (url: string | null) => {
    if (url !== null) {
      const refused = viewerUrlProblem(url);
      if (refused) {
        setProblem(refused);
        return;
      }
    }
    setProblem(null);
    setSaving(true);
    try {
      const saved = await api.setTestStreamViewerUrl(stream.id, url);
      onSaved(saved);
      snackbar.success(saved.viewerUrl ? 'Viewer address saved.' : 'Viewer address cleared.');
    } catch (e) {
      setProblem(errorMessage(e, 'Failed to save the viewer address'));
    } finally {
      setSaving(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(storedViewerUrl(value));
  };

  const link = stream.viewerUrl ? watchPageUrl(stream.viewerUrl, stream) : null;

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={3}>
        <Typography variant="h6">Watching the test</Typography>

        <Section title="Deploying a viewer">
          <Typography variant="body2">{DEPLOY_A_VIEWER}</Typography>
          {feed ? (
            <>
              <ValueField label="Feed owner" value={feed.owner} />
              <ValueField label="Feed topic" value={feed.topic} />
            </>
          ) : (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Reading the catalogue’s owner and topic…
            </Typography>
          )}
        </Section>

        <Section title="The viewer’s address">
          <Box component="form" onSubmit={submit} noValidate>
            <Stack spacing={1.5}>
              <TextField
                id="test-stream-viewer-url"
                label="Viewer address"
                placeholder="http://203.0.113.7:10004"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setProblem(null);
                }}
                error={problem !== null}
                helperText={problem ?? VIEWER_ADDRESS_HELP}
                disabled={saving}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { spellCheck: false, sx: { fontFamily: monoFont, fontSize: 13 } } }}
              />
              <Stack direction="row" spacing={1}>
                <Button type="submit" variant="outlined" size="small" disabled={saving}>
                  Save address
                </Button>
                {stream.viewerUrl ? (
                  <Button size="small" color="warning" disabled={saving} onClick={() => void save(null)}>
                    Clear address
                  </Button>
                ) : null}
              </Stack>
            </Stack>
          </Box>
        </Section>

        {link ? (
          <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
            <Button
              component="a"
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              variant="contained"
              endIcon={<OpenInNewIcon />}
            >
              Watch test stream
            </Button>
            <Typography
              variant="caption"
              sx={{ fontFamily: monoFont, wordBreak: 'break-all', color: 'text.secondary' }}
            >
              {link}
            </Typography>
          </Stack>
        ) : (
          <Alert severity="info">Give the viewer’s address to get the link that opens this test on it.</Alert>
        )}
      </Stack>
    </Paper>
  );
}
