import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import type { UserSummary } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { formatDateTime } from '../../dateUtil';
import { errorMessage } from '../../errors';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSnackbar } from '../Snackbar';

const NEVER_SIGNED_IN = 'Never';

/** Why the Remove button is greyed out, in the words the tooltip shows. */
const CANNOT_REMOVE = {
  forbidden: 'Only an admin can remove a user.',
  self: 'You cannot remove your own account. Ask another admin to remove it.',
  last: 'This is the last user. Removing it would lock everyone out.',
  lastAdmin: 'This is the last admin. Removing it would leave nobody who can manage users.',
  none: '',
} as const;

const NO_SESSIONS = 'This user has no open sessions.';
const CANNOT_REVOKE_OTHERS = 'Only an admin can sign someone else out.';

// A disabled button receives no pointer events, so each Tooltip below wraps its
// button in a span that does. Without it the reason a button is greyed out is
// on screen for nobody, mouse or screen reader alike.

type RemovalBlock = keyof typeof CANNOT_REMOVE;

/**
 * The first reason this user cannot be removed, in the order the operator
 * would hit them. The API enforces all of this too; saying it here means the
 * button explains itself rather than answering with a 409 after the click.
 */
export function removalBlockedBecause(
  user: UserSummary,
  currentUsername: string,
  users: UserSummary[],
  canManage: boolean,
): RemovalBlock {
  if (!canManage) return 'forbidden';
  if (user.username === currentUsername) return 'self';
  if (users.length <= 1) return 'last';
  if (user.isAdmin && users.filter((u) => u.isAdmin).length <= 1) {
    return 'lastAdmin';
  }
  return 'none';
}

interface Pending {
  title: string;
  message: string;
  confirmText: string;
  run: () => Promise<void>;
}

/**
 * Who can log in, and the two things that can be done to each of them.
 *
 * Both actions ask first: removing a user cannot be undone, and signing one out
 * everywhere interrupts whatever they were in the middle of.
 */
export function UsersCard({
  users,
  error,
  currentUsername,
  canManage,
  reload,
}: {
  users: UserSummary[] | null;
  error: string | null;
  currentUsername: string;
  /** Whether the signed-in user may act on the others. */
  canManage: boolean;
  reload: () => Promise<void>;
}) {
  const snackbar = useSnackbar();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (user: UserSummary, done: string, action: (id: string) => Promise<void>) => {
    setBusyId(user.id);
    try {
      await action(user.id);
      snackbar.success(done);
      await reload();
    } catch (caught) {
      snackbar.error(errorMessage(caught, 'That did not work.'));
    } finally {
      setBusyId(null);
    }
  };

  const askRemove = (user: UserSummary) =>
    setPending({
      title: `Remove ${user.username}?`,
      message: 'They will be signed out everywhere and will not be able to log in ' + 'again. This cannot be undone.',
      confirmText: 'Remove',
      run: () => run(user, `Removed ${user.username}`, api.removeUser),
    });

  const askRevoke = (user: UserSummary) =>
    setPending({
      title: `Sign ${user.username} out everywhere?`,
      message:
        user.username === currentUsername
          ? 'Every browser you are logged in with is asked for the password again, this one included.'
          : 'Every browser they are logged in with is asked for the password again.',
      confirmText: 'Sign out everywhere',
      run: () => run(user, `Signed ${user.username} out everywhere`, api.revokeSessions),
    });

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Stack spacing={0.5}>
          <Typography variant="h6">Users</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Everyone who can log in to this console.
          </Typography>
        </Stack>

        {error ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void reload()}>
                Retry
              </Button>
            }
          >
            Could not read the users from the server. {error}
          </Alert>
        ) : null}

        {!users && !error ? (
          <Stack sx={{ alignItems: 'center', py: 4 }}>
            <CircularProgress size={24} aria-label="Loading users" />
          </Stack>
        ) : null}

        {users ? (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>User</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last login</TableCell>
                <TableCell align="right">Open sessions</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((user) => {
                const blocked = removalBlockedBecause(user, currentUsername, users, canManage);
                const busy = busyId === user.id;
                const isSelf = user.username === currentUsername;
                const revokeBlocked =
                  user.sessions === 0 ? NO_SESSIONS : !canManage && !isSelf ? CANNOT_REVOKE_OTHERS : '';

                return (
                  <TableRow key={user.id} hover>
                    <TableCell>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {user.username}
                        </Typography>
                        {user.isAdmin ? <Chip label="admin" size="small" color="primary" /> : null}
                        {isSelf ? (
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            you
                          </Typography>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {formatDateTime(user.createdAt)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : NEVER_SIGNED_IN}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{user.sessions}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                        <Tooltip title={revokeBlocked}>
                          <Box component="span">
                            <Button
                              size="small"
                              disabled={busy || revokeBlocked !== ''}
                              onClick={() => askRevoke(user)}
                            >
                              Sign out everywhere
                            </Button>
                          </Box>
                        </Tooltip>
                        <Tooltip title={CANNOT_REMOVE[blocked]}>
                          <Box component="span">
                            <Button
                              size="small"
                              color="error"
                              disabled={busy || blocked !== 'none'}
                              onClick={() => askRemove(user)}
                            >
                              Remove
                            </Button>
                          </Box>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </Stack>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        message={pending?.message ?? ''}
        confirmText={pending?.confirmText ?? 'Confirm'}
        busy={busyId !== null}
        onConfirm={() => {
          const request = pending;
          setPending(null);
          if (request) void request.run();
        }}
        onCancel={() => setPending(null)}
      />
    </Paper>
  );
}
