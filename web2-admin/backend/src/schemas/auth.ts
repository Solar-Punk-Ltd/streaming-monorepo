import { InferType, object, string } from 'yup';

import { PASSWORD_MIN_LENGTH } from '../types/index.js';

const USERNAME_MAX = 64;
/** Long enough for any passphrase, short enough not to be a scrypt DoS. */
const PASSWORD_MAX = 200;

export const loginSchema = object({
  username: string().required().trim().min(1).max(USERNAME_MAX),
  password: string().required().min(1).max(PASSWORD_MAX),
}).noUnknown(true);

export type LoginBody = InferType<typeof loginSchema>;

export const changePasswordSchema = object({
  currentPassword: string().required().min(1).max(PASSWORD_MAX),
  newPassword: string()
    .required()
    .min(
      PASSWORD_MIN_LENGTH,
      `newPassword must be at least ${PASSWORD_MIN_LENGTH} characters`,
    )
    .max(PASSWORD_MAX),
}).noUnknown(true);

export type ChangePasswordBody = InferType<typeof changePasswordSchema>;
