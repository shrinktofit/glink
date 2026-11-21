import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu } from 'electron';
import { App } from '../../src/app.ts';

const [directory, preloadPath] = process.argv.slice(2);
assert(isAbsolute(directory) && directory.startsWith(join(tmpdir(), 'glink-window-controls-')));
app.setPath('userData', join(directory, 'profile'));

async function testWindowControls() {
  // Keep all test-owned windows hidden without changing production window behavior.
  app.on('browser-window-created', (_event, window) => {
    window.on('show', () => window.hide());
  });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const webRoot = join(directory, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html><title>Window controls</title></html>');
  const application = await App.start({
    glinkHome: join(directory, 'home'),
    webRoot,
    host: '127.0.0.1',
    port: 0,
    background: true,
    iconPath: fileURLToPath(new URL('../../assets/icon.png', import.meta.url)),
    preloadPath,
  });
  await application.showWindow();
  const window = BrowserWindow.getAllWindows()[0];
  const contents = window.webContents;
  assert.deepEqual(await contents.executeJavaScript(`({
    node: typeof require,
    process: typeof process,
    devTools: typeof window.glinkWindow?.openDevTools
  })`), { node: 'undefined', process: 'undefined', devTools: 'function' });

  let opened = once(contents, 'devtools-opened');
  await contents.executeJavaScript('window.glinkWindow.openDevTools()');
  await opened;
  assert(contents.isDevToolsOpened());
  let closed = once(contents, 'devtools-closed');
  contents.closeDevTools();
  await closed;

  await contents.executeJavaScript('window.readingMarker = true');
  const loaded = once(contents, 'did-finish-load');
  await contents.executeJavaScript('setTimeout(() => window.location.reload(), 0)');
  await loaded;
  assert.equal(await contents.executeJavaScript('typeof window.readingMarker'), 'undefined');
  opened = once(contents, 'devtools-opened');
  await contents.executeJavaScript('window.glinkWindow.openDevTools()');
  await opened;
  closed = once(contents, 'devtools-closed');
  contents.closeDevTools();
  await closed;

  await contents.loadURL('data:text/html,<html><title>Unrelated document</title></html>');
  await assert.rejects(contents.executeJavaScript('window.glinkWindow.openDevTools()'),
    /Window commands require the Glink main frame/);
  assert(!contents.isDevToolsOpened());
  console.log('GLINK_WINDOW_TEST ' + JSON.stringify({
    nativeWindow: true,
    reloaded: true,
    isolated: true,
    rejectedUntrusted: true,
  }));
  app.quit();
}

testWindowControls().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
