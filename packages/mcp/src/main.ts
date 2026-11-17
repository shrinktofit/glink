import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createGlinkMcpServer } from './server.ts';

const { values } = parseArgs({
  options: {
    'backend-url': {
      type: 'string',
      default: 'http://127.0.0.1:4310',
    },
  },
});

const backendUrl = new URL(values['backend-url']);

if (backendUrl.protocol !== 'http:' && backendUrl.protocol !== 'https:') {
  throw new Error('Glink backend URL must use HTTP or HTTPS.');
}

serveStdio(() => createGlinkMcpServer(backendUrl), {
  onerror: (error) => console.error(error),
});
