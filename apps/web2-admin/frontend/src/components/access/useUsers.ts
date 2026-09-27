import { useCallback, useEffect, useState } from 'react';
import type { UserSummary } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';

export interface UsersState {
  /** Null until the first answer arrives, which is the loading state. */
  users: UserSummary[] | null;
  error: string | null;
  reload: () => Promise<void>;
}

export function useUsers(): UsersState {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setUsers(await api.fetchUsers());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not read the users.'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { users, error, reload };
}
