import type { IncomingMessage, ServerResponse } from 'node:http';
import { healthPath, type HealthResponse } from '@glink/protocol/health';
import { handleGitRequest } from './git/handle-git-request.ts';

export function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/git/')) {
    handleGitRequest(request, response, url).catch((error: unknown) => {
      console.error('Git HTTP request failed:', error);
      response.writeHead(500).end();
    });
    return;
  }
  if (url.pathname !== healthPath) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  const health: HealthResponse = { service: 'glink' };
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(health));
}
