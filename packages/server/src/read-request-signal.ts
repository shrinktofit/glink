import type { ServerResponse } from 'node:http';

/** A completed request body is not a cancellation; only a disconnected response cancels reads. */
export function readRequestSignal(response: ServerResponse) {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) {
      controller.abort(new Error('Read request disconnected.'));
    }
  });
  return controller.signal;
}
