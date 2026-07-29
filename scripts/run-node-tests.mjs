import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testDir, name))
  .sort();

if (testFiles.length === 0) {
  console.error('No test/*.test.ts files found.');
  process.exit(1);
}

const tsxCli = require.resolve('tsx/cli');
const withCoverage = process.argv.includes('--coverage');

/** @type {string[]} */
let nodeArgs;
if (withCoverage) {
  const c8Cli = require.resolve('c8/bin/c8');
  nodeArgs = [
    c8Cli,
    '--include=src',
    '--exclude=src/extension.ts',
    '--reporter=text',
    '--reporter=lcov',
    '--check-coverage',
    '--lines',
    '80',
    '--functions',
    '80',
    '--branches',
    '70',
    '--statements',
    '80',
    process.execPath,
    tsxCli,
    '--test',
    ...testFiles,
  ];
} else {
  nodeArgs = [tsxCli, '--test', ...testFiles];
}

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
