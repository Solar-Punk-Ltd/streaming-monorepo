import {
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MESSAGE,
  USERNAME_RE,
} from '@streaming-monorepo/web2-admin-common';
import { boolean, InferType, object, string } from 'yup';

import { UUID_RE } from './stream.js';

/**
 * The sign-in body. Both fields are bounded and neither is shape-checked: a
 * wrong pair must answer the same way whatever it looked like, and the rules
 * that decide whether a password is good enough belong to the routes that set
 * one. The bound is here because the route needs no session, so without it any
 * caller could make scrypt hash a 256 KB body as often as it liked.
 */
export const loginSchema = object({
  username: string().required('username is required').max(USERNAME_MAX_LENGTH),
  password: string().required('password is required').max(PASSWORD_MAX_LENGTH),
}).noUnknown(true);

export type LoginBody = InferType<typeof loginSchema>;

/**
 * Adding a user. The username is shape-checked here so a bad one is refused
 * before it reaches the database's CHECK; the password is only required, and
 * `passwordProblem` in web2-admin-common has the last word on it, so the
 * operator is told what is wrong rather than that a regex did not match.
 */
export const createUserSchema = object({
  username: string().required('username is required').matches(USERNAME_RE, USERNAME_MESSAGE),
  password: string().required('password is required').max(PASSWORD_MAX_LENGTH),
  /** Let the new user manage users too. Left out means no. */
  admin: boolean().optional(),
}).noUnknown(true);

export type CreateUserBody = InferType<typeof createUserSchema>;

export const changePasswordSchema = object({
  currentPassword: string().required('currentPassword is required').max(PASSWORD_MAX_LENGTH),
  newPassword: string().required('newPassword is required').max(PASSWORD_MAX_LENGTH),
}).noUnknown(true);

export type ChangePasswordBody = InferType<typeof changePasswordSchema>;

export const userIdParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
}).strict();
