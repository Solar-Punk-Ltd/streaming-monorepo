/** The gateway Bee API a probe reads through, from READ_URL, or the stage's PORT_SLOT on the address the deploy bound it to. */
export function probeReadUrl(env?: Record<string, string | undefined>): string;

/** The uploader Bee API a probe writes through, from WRITE_URL, or the stage's PORT_SLOT on the address the deploy bound it to. */
export function probeWriteUrl(env?: Record<string, string | undefined>): string;
