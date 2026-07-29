import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'src-test-electron', 'extension.test.ts')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'out-test-electron', 'extension.test.js'),
  external: ['vscode', 'mocha', 'assert'],
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
});
