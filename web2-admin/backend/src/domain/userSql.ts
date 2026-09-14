/** Shared projection; `SELECT *` would start leaking new columns into types. */
export const USER_COLUMNS = `
  id, username, password_hash, password_changed_at, created_at, updated_at
`;
