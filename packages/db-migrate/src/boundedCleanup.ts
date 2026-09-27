export const CLEANUP_TIMEOUT_MS = 5000;

/**
 * Waits for a rollback or an unlock at most `timeoutMs`, so a connection that stopped answering costs the runner
 * that connection and never the process's startup.
 */
export async function boundedCleanup<T>(work: Promise<T>, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Migration connection cleanup timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
