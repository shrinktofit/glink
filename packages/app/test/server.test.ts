import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlinkServer } from '../src/server.ts';

const prefix = join(tmpdir(), 'glink-http-host-');

describe('Glink application HTTP server with isolated data and frontend files', () => {
  let directory: string;
  let webRoot: string;
  let server: GlinkServer | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(prefix);
    webRoot = join(directory, 'web');
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    await writeFile(join(webRoot, 'index.html'), '<html><title>Glink fixture</title></html>');
    await writeFile(join(webRoot, 'assets/worker.js'), 'self.onmessage = () => {};');
    await writeFile(join(directory, 'private.txt'), 'outside frontend');
    server = await GlinkServer.start({
      glinkHome: join(directory, 'home'),
      webRoot,
      host: '127.0.0.1',
      port: 0,
    });
  });
  afterEach(async () => {
    await server?.close();
    if (!directory.startsWith(prefix)) {
      throw new Error('Unexpected server test directory.');
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('serves the UI, deep routes, worker assets and APIs from the same origin', async () => {
    /// @case Desktop and browser clients load pages, encoded router paths and API endpoints.
    /// @expect All entries share one service; router parameters are never mistaken for assets.
    const origin = server!.url;
    for (const path of ['', 'workspace/Helix.v2', 'worktree/U%3A%2Frepo%2Fengine.v2']) {
      const page = await fetch(new URL(path, origin));
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('Glink fixture');
    }
    const worker = await fetch(new URL('assets/worker.js', origin));
    expect(worker.headers.get('content-type')).toMatch(/javascript/);
    expect(await worker.text()).toContain('self.onmessage');
    const head = await fetch(new URL('assets/worker.js', origin), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const cached = await fetch(new URL('assets/worker.js', origin), {
      headers: { 'If-None-Match': worker.headers.get('etag')! },
    });
    expect(cached.status).toBe(304);
    expect(await (await fetch(new URL('api/health', origin))).json()).toEqual({ service: 'glink' });
    const catalog = await (await fetch(new URL('api/glink/state', origin))).json();
    expect(catalog.workspaces).toEqual([]);
    expect(catalog.home).toBe(join(directory, 'home'));
  });

  it('keeps missing assets and external paths out of SPA fallback', async () => {
    /// @case A client requests missing scripts, unknown API paths and an encoded traversal path.
    /// @expect Return errors without disclosing external files or replacing scripts with HTML.
    for (const path of ['assets/missing.js', 'api/missing', 'assets/..%2F..%2Fprivate.txt']) {
      const response = await fetch(new URL(path, server!.url));
      expect(response.status, path).toBe(404);
      const body = await response.text();
      expect(body).not.toContain('Glink fixture');
      expect(body).not.toContain('outside frontend');
    }
    const post = await fetch(server!.url, { method: 'POST', body: 'not a page request' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('surfaces a port conflict without disturbing the running service', async () => {
    /// @case Another application server attempts to bind the existing server port.
    /// @expect The second start fails and the original service remains available.
    await expect(GlinkServer.start({
      glinkHome: join(directory, 'other-home'),
      webRoot,
      host: '127.0.0.1',
      port: Number(new URL(server!.url).port),
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect((await fetch(new URL('api/health', server!.url))).status).toBe(200);
  });

  it('waits for an accepted API request before finishing shutdown', async () => {
    /// @case Shutdown begins after HTTP accepts a request whose body has not finished yet.
    /// @expect The request can finish, shutdown waits, then no new client is accepted.
    const payload = JSON.stringify({ name: 'During shutdown', worktreePaths: [] });
    const pending = request(new URL('api/workspaces', server!.url), {
      method: 'POST',
      headers: {
        'Expect': '100-continue',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });
    const response = once(pending, 'response');
    pending.flushHeaders();
    await once(pending, 'continue');
    let stopped = false;
    const stopping = server!.close().then(() => {
      stopped = true;
    });
    await setImmediate();
    expect(stopped).toBe(false);
    pending.end(payload);
    const [result] = await response;
    result.resume();
    await once(result, 'end');
    expect(result.statusCode).toBe(200);
    await stopping;
    await expect(fetch(new URL('api/health', server!.url))).rejects.toThrow();
  }, 10000);
});
