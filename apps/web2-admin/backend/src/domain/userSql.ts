/** Shared projection; `SELECT *` would start leaking new columns into types. */
export const USER_COLUMNS = `
  id, username, password_hash, is_admin, password_changed_at,
  last_login_at, created_at, updated_at
`;

/** The same columns qualified and aliased, for the session ⋈ user join. */
export const JOINED_USER_COLUMNS = `
  u.id AS u_id, u.username AS u_username, u.password_hash AS u_password_hash,
  u.is_admin AS u_is_admin, u.password_changed_at AS u_password_changed_at,
  u.last_login_at AS u_last_login_at, u.created_at AS u_created_at,
  u.updated_at AS u_updated_at
`;
