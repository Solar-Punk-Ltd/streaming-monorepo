/**
 * Advisory-lock key guarding user removal. ASCII "user".
 *
 * Removing a user has to read how many are left and delete in one step, or two
 * browsers each removing the other both see two users and both delete, leaving
 * a console nobody can sign in to. The count and the DELETE therefore run in
 * one transaction under this lock.
 */
export const USER_REMOVAL_LOCK_KEY = 0x75736572;
