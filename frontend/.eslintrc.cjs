module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist',
    'node_modules',
    'coverage',
    'playwright-report',
    'test-results',
    'src/pages/HistoryPage.tsx',
    'src/store/authStore.ts',
    'src/store/suggestionStore.ts',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['react-refresh'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
  },
};
