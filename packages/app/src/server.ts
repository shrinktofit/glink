import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import sirv from 'sirv';
import { createGlinkRequestHandler } from './workspace/workspace-request-handler.ts';

export interface GlinkServerOptions {
  glinkHome: string;
  webRoot: string;
  host: string;
  port: number;
}

/** The application server shared by desktop windows, browsers and MCP clients. */
export class GlinkServer {
  static async start(options: GlinkServerOptions) {
    if (!(await stat(join(options.webRoot, 'index.html'))).isFile()) {
      throw new Error('Glink frontend index.html is not a file.');
    }
    const api = await createGlinkRequestHandler({ glinkHome: options.glinkHome });
    const assets = sirv(options.webRoot, {
      single: true,
      etag: true,
      ignores: [/^\/assets(?:\/|$)/],
    });
    const server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        api(request, response);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      // Router parameters may contain dots and encoded slashes; they are not asset paths.
      const originalUrl = request.url;
      if (/^\/(?:workspace|worktree)(?:\/|$)/.test(pathname)) {
        request.url = '/index.html';
      }
      assets(request, response);
      request.url = originalUrl;
    });
    const listening = once(server, 'listening');
    server.listen(options.port, options.host);
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Glink requires a TCP server address.');
    }
    const localHost = options.host === '0.0.0.0'
      ? '127.0.0.1'
      : options.host === '::' ? '::1' : options.host;
    const hostname = isIP(localHost) === 6 ? `[${localHost}]` : localHost;
    return new GlinkServer(server, `http://${hostname}:${address.port}/`);
  }

  readonly url: string;

  /** Stop accepting clients and let in-flight requests (including Git writes) settle. */
  close(): Promise<void> {
    this._closing ??= new Promise<void>((fulfill, reject) => {
      this._server.close((error) => error ? reject(error) : fulfill());
    });
    return this._closing;
  }

  private constructor(server: Server, url: string) {
    this._server = server;
    this.url = url;
  }

  private readonly _server: Server;
  private _closing?: Promise<void>;
}
