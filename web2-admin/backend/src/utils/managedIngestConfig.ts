export interface ManagedIngestLifecycleConfig {
  lifecycleVersion: 1;
  uploaderId: string;
}

type Environment = Record<string, string | undefined>;

export function managedIngestLifecycleConfig(
  environment: Environment,
): ManagedIngestLifecycleConfig | null {
  const rawVersion = environment.INGEST_MANAGED_LIFECYCLE_VERSION?.trim() ?? '';
  const uploaderId = environment.INGEST_MANAGED_UPLOADER_ID?.trim() ?? '';
  if (rawVersion === '') {
    if (uploaderId !== '') {
      throw new Error(
        'INGEST_MANAGED_LIFECYCLE_VERSION is required when INGEST_MANAGED_UPLOADER_ID is set',
      );
    }
    return null;
  }
  if (rawVersion !== '1') {
    throw new Error('INGEST_MANAGED_LIFECYCLE_VERSION must be 1');
  }
  if (uploaderId === '') {
    throw new Error(
      'INGEST_MANAGED_UPLOADER_ID is required when INGEST_MANAGED_LIFECYCLE_VERSION is 1',
    );
  }
  if (uploaderId.length > 200) {
    throw new Error('INGEST_MANAGED_UPLOADER_ID must be at most 200 characters');
  }
  return { lifecycleVersion: 1, uploaderId };
}
