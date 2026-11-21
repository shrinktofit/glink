import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

export interface AppOptions {
  background: boolean;
  host: string;
  port: number;
  userDataPath?: string;
}

export function readAppOptions(args: string[]): AppOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      'background': { type: 'boolean', default: false },
      'host': { type: 'string', default: '0.0.0.0' },
      'port': { type: 'string', default: '4310' },
      'user-data-dir': { type: 'string' },
    },
  });
  if (typeof values.background !== 'boolean'
    || typeof values.host !== 'string' || !values.host.trim()) {
    throw new Error('Invalid Glink background or host option.');
  }
  if (typeof values.port !== 'string' || !/^\d+$/.test(values.port)
    || Number(values.port) > 65535) {
    throw new Error('Glink --port must be an integer between 0 and 65535.');
  }
  const userData = values['user-data-dir'];
  if (userData !== undefined && (typeof userData !== 'string' || !userData.trim())) {
    throw new Error('Glink --user-data-dir requires a directory.');
  }
  return {
    background: values.background,
    host: values.host,
    port: Number(values.port),
    userDataPath: userData === undefined ? undefined : resolve(userData),
  };
}
