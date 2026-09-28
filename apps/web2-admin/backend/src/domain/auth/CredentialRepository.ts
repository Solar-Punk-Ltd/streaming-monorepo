import type { NewSession } from './SessionRepository.js';

/**
 * The writes a verified password admits, each as one step.
 *
 * A password is verified outside any transaction, because the hash is slow on
 * purpose. Each write here reads the stored hash again under the user's row
 * lock and refuses when it is no longer the one that was verified, so a
 * password change cannot race the check that admitted the write.
 *
 * Setting the hash and dropping the user's other sessions used to be two
 * statements. If the second one failed the password had changed and the
 * sessions it was being changed because of were still open, which is the exact
 * situation the "your other browsers were signed out" promise rules out.
 */
export interface CredentialRepository {
  /**
   * Creates the session and records the sign-in, only while the verified
   * password hash is still the stored one.
   */
  admitSession(userId: string, verifiedPasswordHash: string, session: NewSession, signedInAt: Date): Promise<boolean>;
  /**
   * Sets the password hash and deletes every session of the user except the
   * one making the change, atomically, only while the verified password hash
   * is still the stored one.
   */
  changePassword(
    userId: string,
    verifiedPasswordHash: string,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<boolean>;
}
