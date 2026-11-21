import { once } from 'node:events';
import { createServer } from 'node:http';
import { healthPath } from '@glink/protocol/health';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/request-handler.ts';

describe('Glink HTTP health endpoint', () => {
  const server = createServer(handleRequest);
  let origin: string;

  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The test server must listen on a TCP port.');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((fulfill, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          fulfill();
        }
      });
    });
  });

  it('serves the shared health contract over HTTP', async () => {
    /// @case A client requests the health endpoint on a real HTTP server.
    /// @expect The endpoint returns a successful JSON response identifying Glink.
    const response = await fetch(`${origin}${healthPath}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ service: 'glink' });
  });

  it('returns not found for routes that do not exist', async () => {
    /// @case A client requests an unknown API route.
    /// @expect The server returns 404 rather than a successful health response.
    const response = await fetch(`${origin}/api/missing`);
    expect(response.status).toBe(404);
  });

  it('advertises GET when a client uses an unsupported method', async () => {
    /// @case A client posts to the read-only health endpoint.
    /// @expect The server returns 405 with GET as its allowed method.
    const response = await fetch(`${origin}${healthPath}`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});
