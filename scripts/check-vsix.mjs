import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = path.join(root, vsixName);

if (!fs.existsSync(vsixPath)) {
  console.error(`Missing VSIX: ${vsixPath}`);
  process.exit(1);
}

const listing = execFileSync('unzip', ['-l', vsixPath], { encoding: 'utf8' });
const requiredGroups = [
  ['extension/package.json'],
  ['extension/dist/extension.js'],
  ['extension/README.md', 'extension/readme.md'],
  ['extension/LICENSE.txt', 'extension/LICENSE'],
  ['extension/CHANGELOG.md', 'extension/changelog.md'],
];

for (const alts of requiredGroups) {
  if (!alts.some((candidate) => listing.includes(candidate))) {
    console.error(`VSIX missing required entry matching: ${alts.join(' | ')}`);
    process.exit(1);
  }
}

const forbidden = [
  'extension/src/',
  'extension/test/',
  'extension/.github/',
  'extension/node_modules/',
  'extension/coverage/',
  'extension/AGENTS.md',
  'extension/CONTRIBUTING.md',
  'extension/SECURITY.md',
  'extension/CODE_OF_CONDUCT.md',
];

for (const item of forbidden) {
  if (listing.includes(item)) {
    console.error(`VSIX unexpectedly contains: ${item}`);
    process.exit(1);
  }
}

const extractedPkg = execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], {
  encoding: 'utf8',
});
const vsixPkg = JSON.parse(extractedPkg);
if (vsixPkg.version !== pkg.version) {
  console.error(`VSIX package version ${vsixPkg.version} != ${pkg.version}`);
  process.exit(1);
}
if (vsixPkg.main !== './dist/extension.js') {
  console.error(`VSIX main must be ./dist/extension.js, got ${vsixPkg.main}`);
  process.exit(1);
}

console.log(`VSIX OK: ${vsixName}`);
