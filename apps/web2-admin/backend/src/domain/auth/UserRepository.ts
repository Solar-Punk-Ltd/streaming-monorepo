import type { UserRow } from '../../types/index.js';

/**
 * What a removal did: took the row, refused to take the last user, refused to
 * take the last one who can manage users, or found none.
 */
export type UserDeletion = 'deleted' | 'last' | 'last_admin' | 'missing';

export interface UserRepository {
  count(): Promise<number>;
  /** Oldest first, so the list reads as the order people were added. */
  list(): Promise<UserRow[]>;
  findById(id: string): Promise<UserRow | null>;
  findByUsername(username: string): Promise<UserRow | null>;
  /** Null when the username is already taken. */
  insert(
    username: string,
    passwordHash: string,
    isAdmin: boolean,
  ): Promise<UserRow | null>;
  markSignedIn(id: string, at: Date): Promise<void>;
  /**
   * Removes a user unless it is the only one left, or the only one left who
   * can manage users, which would leave nobody able to add the next.
   *
   * One step rather than a count and a delete: two people removing each other
   * at the same moment both counted two users and both deleted, which empties
   * the table and locks everyone out of the console.
   */
  deleteUnlessLast(id: string): Promise<UserDeletion>;
}
