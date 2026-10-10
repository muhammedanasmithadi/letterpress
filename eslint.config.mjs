import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'hack'], location: 'anywhere' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { ignores: ['dist/', 'node_modules/'] },
];
