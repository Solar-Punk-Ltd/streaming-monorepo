/**
 * No export with this id is on the server: it was cancelled, replaced by a newer one, or its stream was deleted. The
 * API answers 404, and the console reads the export on the server again.
 */
export class ExportNotFoundError extends Error {
  constructor(public readonly exportId: string) {
    super(`Export not found: ${exportId}`);
    this.name = 'ExportNotFoundError';
  }
}
