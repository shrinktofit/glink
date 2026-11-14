// @ts-check

import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import stf from '@shrinktofit/eslint-config';
import node from '@shrinktofit/eslint-config/node';
import vue from '@shrinktofit/eslint-config/vue';

export default defineConfig([
  globalIgnores([
    '**/lib/',
    '**/dist/',
    '**/coverage/',
    '**/.local/',
    '**/.turbo/',
  ]),
  { settings: { node: { version: '>=26.0.0' } } },
  ...stf.configs.recommended,
  ...stf.configs.conventions,
  ...vue.configs.recommended,
  {
    files: ['packages/web-app/src/**/*.{ts,vue}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  ...node.configs.recommended.map((config) => ({
    ...config,
    files: [
      'eslint.config.js',
      'packages/*/*.config.ts',
      'packages/server/**/*.ts',
    ],
  })),
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.vue'],
      },
    },
  },
]);
