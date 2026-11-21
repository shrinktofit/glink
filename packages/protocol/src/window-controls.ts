export const openDevToolsChannel = 'glink:window:open-dev-tools';

export interface WindowControls {
  openDevTools(): Promise<void>;
}
