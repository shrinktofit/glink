import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGlinkRequestHandler } from './workspace/workspace-request-handler.ts';

const glinkHome = join(homedir(), '.glink');
const server = createServer(await createGlinkRequestHandler({ glinkHome }));

server.listen(4310, '127.0.0.1', () => {
  console.info('Glink server listening at http://127.0.0.1:4310');
});
