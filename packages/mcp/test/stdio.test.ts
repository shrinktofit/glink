import { once } from 'node:events';
import type { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const prefix = join(tmpdir(), 'glink-stdio-');

describe('Glink MCP process with an independently started backend', () => {
  let directory: string;
  let backend: Server;
  let backendUrl: string;
  let port: number;
  let client: Client;
  let transport: StdioClientTransport;
  let requests: string[];
  let respond: (name: string, response: ServerResponse) => void | Promise<void>;

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    // Consume the complete request, as the real backend does before admitting a tool call.
    const chunks: string[] = [];
    for await (const chunk of request) {
      chunks.push(String(chunk));
    }
    JSON.parse(chunks.join(''));

    const name = request.url?.split('/').at(-1) ?? '';
    requests.push(name);
    await respond(name, response);
  }

  async function startBackend() {
    backend.listen(port, '127.0.0.1');
    await once(backend, 'listening');
  }

  async function stopBackend() {
    await new Promise<void>((fulfill, reject) => {
      backend.close((error) => {
        if (error) {
          reject(error);
        } else {
          fulfill();
        }
      });
    });
  }

  async function connect() {
    transport = new StdioClientTransport({
      command: execPath,
      args: [
        fileURLToPath(new URL('../lib/main.js', import.meta.url)),
        '--backend-url',
        backendUrl,
      ],
      cwd: directory,
      stderr: 'pipe',
    });

    const errors: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      errors.push(chunk.toString());
    });

    client = new Client({
      name: 'glink-stdio-test',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);
    } catch (error: unknown) {
      throw new Error(errors.join('\n'), { cause: error });
    }
  }

  beforeEach(async () => {
    directory = await mkdtemp(prefix);
    requests = [];
    respond = (_name, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ workspaces: [] }));
    };

    backend = createServer((request, response) => {
      handleRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });

    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');

    const address = backend.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }

    port = address.port;
    backendUrl = `http://127.0.0.1:${port}`;
    await stopBackend();
  });

  afterEach(async () => {
    await client?.close();

    if (backend.listening) {
      await stopBackend();
    }

    if (!directory.startsWith(prefix)) {
      throw new Error('Unexpected fixture directory');
    }

    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it('lists tools offline and recovers on the same connection after backend startup and restart',
    async () => {
      /// @case MCP starts first; the backend starts later and then restarts once more.
      /// @expect Tools remain registered and the original MCP process serves subsequent calls.
      await connect();
      const processId = transport.pid;
      const tools = (await client.listTools()).tools;

      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'add_project',
        'create_workspace',
        'get_workspace',
        'list_workspaces',
        'remove_project',
        'remove_workspace',
        'sync_workspace',
        'update_project',
      ]);

      const readOnlyNames = tools
        .filter((tool) => tool.annotations?.readOnlyHint)
        .map((tool) => tool.name)
        .sort();

      expect(readOnlyNames).toEqual(['get_workspace', 'list_workspaces']);

      const offline = await client.callTool({ name: 'list_workspaces', arguments: {} });
      expect(offline.isError).toBe(true);
      expect(offline.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining('Glink') }),
      ]);

      await startBackend();

      const online = await client.callTool({ name: 'list_workspaces', arguments: {} });
      expect(online.isError).not.toBe(true);
      expect(online.structuredContent).toEqual({ workspaces: [] });

      await stopBackend();
      const stopped = await client.callTool({ name: 'list_workspaces', arguments: {} });
      expect(stopped.isError).toBe(true);

      await startBackend();

      const restarted = await client.callTool({ name: 'list_workspaces', arguments: {} });
      expect(restarted.structuredContent).toEqual({ workspaces: [] });
      expect(transport.pid).toBe(processId);
      expect(requests).toEqual(['list_workspaces', 'list_workspaces']);
    });

  it('keeps backend failures distinct from connection failures and forwards a write only once',
    async () => {
      /// @case A backend rejects a mutation; another request has invalid tool arguments.
      /// @expect Return the domain message, do not retry writes, and reject invalid input locally.
      respond = (name, response) => {
        if (name === 'remove_workspace') {
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Workspace changed' }));
          return;
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ workspaces: [] }));
      };

      await startBackend();
      await connect();
      expect(requests).toEqual([]);

      const failed = await client.callTool({
        name: 'remove_workspace',
        arguments: { workspaceId: 'workspace' },
      });

      expect(failed.isError).toBe(true);
      expect(failed.content).toEqual([
        {
          type: 'text',
          text: 'Workspace changed',
        },
      ]);

      const invalid = await client.callTool({
        name: 'update_project',
        arguments: {
          workspaceId: 'workspace',
          projectId: 'project',
          changes: {},
        },
      });

      expect(invalid.isError).toBe(true);
      expect(requests).toEqual(['remove_workspace']);

      const read = await client.callTool({ name: 'list_workspaces', arguments: {} });
      expect(read.structuredContent).toEqual({ workspaces: [] });
    });

  it('cancels one request while keeping the MCP process usable and never replays admitted writes',
    async () => {
      /// @case A write reaches the backend, then its caller cancels before the response arrives.
      /// @expect The caller exits; the admitted write finishes once and other tools still work.
      let entered!: () => void;
      let release!: () => void;
      let writes = 0;

      const started = new Promise<void>((fulfill) => {
        entered = fulfill;
      });
      const gate = new Promise<void>((fulfill) => {
        release = fulfill;
      });

      respond = async (name, response) => {
        if (name === 'create_workspace') {
          entered();
          await gate;
          writes++;
        }

        if (!response.destroyed) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ workspaces: [] }));
        }
      };

      await startBackend();
      await connect();

      const cancellation = new AbortController();
      const pending = client.callTool({
        name: 'create_workspace',
        arguments: {
          name: 'Pending',
          worktreePaths: [],
        },
      }, {
        signal: cancellation.signal,
      });

      try {
        await started;
        cancellation.abort();
        await expect(pending).rejects.toThrow();

        const read = await client.callTool({ name: 'list_workspaces', arguments: {} });
        expect(read.structuredContent).toEqual({ workspaces: [] });
      } finally {
        release();
      }

      await expect.poll(() => writes).toBe(1);
      expect(requests).toEqual(['create_workspace', 'list_workspaces']);
    });
});
