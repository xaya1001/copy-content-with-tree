import { defineConfig } from '@vscode/test-cli';

// VSCODE_TEST_VERSION selects the binary under test.
// Local `npm run check` uses stable; CI also runs engines.vscode minimum (1.80.0).
const version = process.env.VSCODE_TEST_VERSION || 'stable';

export default defineConfig({
  files: 'out-test-electron/**/*.test.js',
  version,
  mocha: {
    timeout: 60_000,
  },
});
