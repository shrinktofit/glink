import { contextBridge, ipcRenderer } from 'electron';
import { openDevToolsChannel, type WindowControls } from '@glink/protocol/window-controls';

const controls: WindowControls = {
  openDevTools: () => ipcRenderer.invoke(openDevToolsChannel),
};

contextBridge.exposeInMainWorld('glinkWindow', controls);
