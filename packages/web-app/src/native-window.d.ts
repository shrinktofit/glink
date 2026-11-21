import type { WindowControls } from '@glink/protocol/window-controls';

declare global {
  interface Window {
    readonly glinkWindow?: WindowControls;
  }
}

export type { WindowControls };
