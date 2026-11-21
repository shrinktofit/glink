import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { app, dialog, Menu } from 'electron';
import { readAppOptions } from './app-options.ts';
import { App } from './app.ts';

function reportStartupError(error: unknown) {
  console.error('Glink startup failed:', error);
  if (!process.argv.includes('--background')) {
    dialog.showErrorBox('Glink 启动失败', error instanceof Error ? error.message : String(error));
  }
  app.exit(1);
}

try {
  const options = readAppOptions(process.argv.slice(1));
  app.setName('Glink');
  app.setAppUserModelId('dev.glink.app');
  if (options.userDataPath) {
    mkdirSync(options.userDataPath, { recursive: true });
    app.setPath('userData', options.userDataPath);
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    const ready = app.whenReady().then(() => {
      Menu.setApplicationMenu(null);
      return App.start({
        ...options,
        glinkHome: join(homedir(), '.glink'),
        webRoot: join(app.getAppPath(), 'lib/web'),
        iconPath: join(app.getAppPath(), 'assets/icon.png'),
      });
    });
    app.on('second-instance', (_event, argv) => {
      if (!readAppOptions(argv).background) {
        ready.then((application) => application.showWindow()).catch(reportStartupError);
      }
    });
    app.on('activate', () => {
      ready.then((application) => application.showWindow()).catch(reportStartupError);
    });
    ready.catch(reportStartupError);
  }
} catch (error: unknown) {
  reportStartupError(error);
}
