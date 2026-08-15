import globals from 'globals';

export default [
  {
    files: ['public/app.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.browser,
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
