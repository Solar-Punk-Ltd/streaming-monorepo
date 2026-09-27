/**
 * The two settings that link an uploader to an admin: where the admin's internal API is, and the token it presents
 * there. The admin names its own copy of the token `INTERNAL_API_TOKEN`. An empty address means no admin.
 */
export const ADMIN_API_URL_KEY = 'ADMIN_API_URL';
export const ADMIN_API_TOKEN_KEY = 'ADMIN_API_TOKEN';

/** The shortest token the uploader, the manager and the admin each accept. */
export const ADMIN_API_TOKEN_MIN_LENGTH = 32;
