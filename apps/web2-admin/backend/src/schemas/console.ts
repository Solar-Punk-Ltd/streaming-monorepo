import { ADMIN_THEME_NAMES, type AdminThemeName } from '@streaming-monorepo/web2-admin-common';
import { type InferType, mixed, object } from 'yup';

/** `PUT /api/config/default-theme`: `SetDefaultThemeRequest`. */
export const defaultThemeSchema = object({
  defaultTheme: mixed<AdminThemeName>()
    .required('defaultTheme is required')
    .oneOf([...ADMIN_THEME_NAMES], `defaultTheme must be one of ${ADMIN_THEME_NAMES.join(', ')}`),
}).noUnknown(true);

export type DefaultThemeBody = InferType<typeof defaultThemeSchema>;
