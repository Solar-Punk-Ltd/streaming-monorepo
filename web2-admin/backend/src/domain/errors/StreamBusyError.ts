import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

export class StreamBusyError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly currentStatus: StreamStatus,
  ) {
    super(`Stream ${streamId} is busy (status=${currentStatus})`);
    this.name = 'StreamBusyError';
  }
}
