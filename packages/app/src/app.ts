import { app, BrowserWindow, dialog, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { GlinkServer, type GlinkServerOptions } from './server.ts';

export interface AppOptions extends GlinkServerOptions {
  background: boolean;
  iconPath: string;
}

/** Owns the single service instance, tray and optional browser window. */
export class App {
  static async start(options: AppOptions) {
    const server = await GlinkServer.start(options);
    const application = new App(server, options.iconPath);
    if (!options.background) {
      await application.showWindow();
    }
    console.info(`Glink server listening at ${server.url} (host ${options.host})`);
    return application;
  }

  async showWindow() {
    if (this._quitting) {
      return;
    }
    if (!this._window) {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      const window = new BrowserWindow({
        title: 'Glink',
        width: Math.min(1440, width),
        height: Math.min(960, height),
        minWidth: 900,
        minHeight: 560,
        show: false,
        icon: this._iconPath,
        backgroundColor: '#f5f6f8',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      this._window = window;
      window.on('close', (event) => {
        if (!this._quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      window.on('closed', () => {
        this._window = undefined;
        this._windowReady = undefined;
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        this._openExternalUrl(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== new URL(this._server.url).origin) {
          event.preventDefault();
          this._openExternalUrl(url);
        }
      });
      this._windowReady = window.loadURL(this._server.url);
    }
    try {
      await this._windowReady;
    } catch (error: unknown) {
      this._window?.destroy();
      throw error;
    }
    if (this._window.isMinimized()) {
      this._window.restore();
    }
    this._window.show();
    this._window.focus();
  }

  private constructor(server: GlinkServer, iconPath: string) {
    this._server = server;
    this._iconPath = iconPath;
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      throw new Error(`Glink tray icon could not be loaded: ${iconPath}`);
    }
    this._tray = new Tray(icon.resize({ width: 20, height: 20 }));
    const show = () => {
      this.showWindow().catch((error: unknown) => {
        this._reportError('无法打开 Glink 窗口', error);
      });
    };
    this._tray.setToolTip(`Glink · ${server.url}`);
    this._tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开窗口', click: show },
      { label: '在浏览器中打开', click: () => this._openExternalUrl(server.url) },
      { type: 'separator' },
      { label: '退出 Glink', click: () => app.quit() },
    ]));
    this._tray.on('click', show);
    app.on('before-quit', (event) => {
      if (!this._stopped) {
        event.preventDefault();
        this._closing ??= this._stop().catch((error: unknown) => {
          this._reportError('Glink 退出失败', error);
          app.exit(1);
        });
      }
    });
  }

  private readonly _server: GlinkServer;
  private readonly _iconPath: string;
  private readonly _tray: Tray;
  private _window?: BrowserWindow;
  private _windowReady?: Promise<void>;
  private _quitting = false;
  private _stopped = false;
  private _closing?: Promise<void>;

  private async _stop() {
    this._quitting = true;
    await this._server.close();
    this._tray.destroy();
    this._stopped = true;
    app.quit();
  }

  private _openExternalUrl(url: string) {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') {
      shell.openExternal(url).catch((error: unknown) => {
        this._reportError('无法打开浏览器', error);
      });
    }
  }

  private _reportError(title: string, error: unknown) {
    console.error(title, error);
    dialog.showErrorBox(title, error instanceof Error ? error.message : String(error));
  }
}
