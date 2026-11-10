import { EXPORT_ACTIONS } from '@streaming-monorepo/web2-admin-common';
import { object, string } from 'yup';

import { UUID_RE } from './stream.js';

export const exportIdParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
}).strict();

/** A rung's name, as `stream_renditions` allows one, or `source`. */
export const exportStartSchema = object({
  rendition: string()
    .required()
    .matches(/^[A-Za-z0-9.-]{1,32}$/, 'rendition must be a rung name or source'),
}).strict();

export const exportActionSchema = object({
  action: string()
    .required()
    .oneOf([...EXPORT_ACTIONS], `action must be one of ${EXPORT_ACTIONS.join(', ')}`),
}).strict();
