import type { InjectionKey } from 'vue';
import type { App } from './app';
export const appKey: InjectionKey<App> = Symbol('Glink app');
