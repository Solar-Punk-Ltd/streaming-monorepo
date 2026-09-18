import { Stack, Typography } from '@mui/material';

import { useAuth } from '../auth';
import { AddUserCard } from '../components/access/AddUserCard';
import { ChangePasswordCard } from '../components/access/ChangePasswordCard';
import { UsersCard } from '../components/access/UsersCard';
import { useUsers } from '../components/access/useUsers';

/**
 * Who can log in. An admin adds and removes the others and signs anyone out.
 * Everyone else sees the list, and can change their own password and sign
 * themselves out everywhere.
 *
 * This is also where the account's own password lives, so there is one page
 * about logging in rather than two.
 */
export function AccessPage() {
  const { user } = useAuth();
  const { users, error, reload } = useUsers();

  const currentUsername = user?.username ?? '';
  const canManage = user?.isAdmin === true;

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        Access
      </Typography>

      <Typography variant="body2" color="text.secondary">
        {canManage
          ? 'You can add and remove users here.'
          : 'Only an admin adds or removes a user.'}{' '}
        A session lasts twelve hours of inactivity, and fourteen days at most.
      </Typography>

      <UsersCard
        users={users}
        error={error}
        currentUsername={currentUsername}
        canManage={canManage}
        reload={reload}
      />
      {canManage ? <AddUserCard onAdded={reload} /> : null}
      <ChangePasswordCard />
    </Stack>
  );
}
