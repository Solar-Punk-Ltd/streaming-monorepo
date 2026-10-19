/**
 * The two settings that link an uploader to an admin: where the admin's internal API is, and the token it presents
 * there, its stage's own token, which the manager generated for the deployment and pushed to the admin by its sha256.
 * The admin's own `INTERNAL_API_TOKEN` is the manager's registrar token and is refused on the uploader's routes. An
 * empty address means no admin.
 */
export const ADMIN_API_URL_KEY = 'ADMIN_API_URL';
export const ADMIN_API_TOKEN_KEY = 'ADMIN_API_TOKEN';

/** The shortest token the uploader, the manager and the admin each accept. */
export const ADMIN_API_TOKEN_MIN_LENGTH = 32;
