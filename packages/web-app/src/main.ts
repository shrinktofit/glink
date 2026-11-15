import { App } from './app';

try {
  await App.create();
} catch (error: unknown) {
  document.querySelector('#root')!.textContent
    = error instanceof Error ? error.message : String(error);
}
