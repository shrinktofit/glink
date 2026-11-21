import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import stf from '@shrinktofit/eslint-config';
import node from '@shrinktofit/eslint-config/node';
import vue from '@shrinktofit/eslint-config/vue';

export default defineConfig([
  globalIgnores([
    '**/lib/',
    '**/dist/',
    '**/.pkg/',
    '**/coverage/',
    '**/.local/',
    '**/.turbo/',
  ]),
  {
    settings: {
      node: {
        version: '>=26.0.0',
      },
    },
  },
  ...stf.configs.recommended,
  ...stf.configs.conventions,
  ...vue.configs.recommended,
  {
    files: ['packages/web-app/src/**/*.{ts,vue}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      'eslint.config.ts',
      'packages/*/*.config.ts',
      'packages/app/**/*.ts',
      'packages/mcp/**/*.ts',
    ],
    extends: [node.configs.recommended],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.vue'],
      },
    },
  },
]);
