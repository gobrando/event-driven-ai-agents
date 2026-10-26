import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.state/**', 'examples/vercel/**'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node } },
];
