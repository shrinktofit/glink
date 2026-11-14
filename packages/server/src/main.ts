import { createServer } from 'node:http';
import { handleRequest } from './request-handler.ts';

const server = createServer(handleRequest);

server.listen(4310, '127.0.0.1', () => {
  console.info('Glink server listening at http://127.0.0.1:4310');
});
