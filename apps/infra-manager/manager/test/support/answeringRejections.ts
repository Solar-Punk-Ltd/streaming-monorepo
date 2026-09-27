import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A request handler for a test server that answers 500 with the error when the handler rejects. Without it
 * the request stays open until the client gives up and the rejection goes unhandled, far from its cause.
 */
export function answeringRejections(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  };
}
