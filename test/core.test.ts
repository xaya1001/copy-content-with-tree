import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONFIG,
  mergeExcludes,
  normalizePathRewrite,
  normalizeNonNegativeInteger,
  readConfigFromGetter,
} from '../src/core/config';
import { shouldExclude } from '../src/core/excludes';
import { makeTree } from '../src/core/tree';
import { isProbablyBinary } from '../src/core/binary';
import {
  escapePathForDisplay,
  toDisplayPath,
  toPosixPath,
  toSafePathLabel,
  rewritePath,
  isPathInside,
  isPathInsideOrEqual,
} from '../src/core/paths';
import { parseNulPaths, parseNameStatusNul } from '../src/git/exec';
import { shouldExcludeDiffEntry, statusLabel } from '../src/git/diff';

test('pathRewrite default is empty and invalid rules are dropped', () => {
  assert.deepEqual(DEFAULT_CONFIG.pathRewrite, []);
  assert.deepEqual(normalizePathRewrite(undefined), []);
  assert.deepEqual(normalizePathRewrite([{ from: '/a', to: '/b' }, { from: '', to: '/b' }, null]), [
    { from: '/a', to: '/b' },
  ]);
});

test('config getter applies minimums and defaults', () => {
  const values: Record<string, unknown> = {
    maxFileSizeKB: 0,
    gitTimeoutMs: 100,
    pathRewrite: [{ from: '/x', to: '/y' }],
  };
  const cfg = readConfigFromGetter(<T>(key: string, fallback: T): T => {
    return (key in values ? values[key] : fallback) as T;
  });
  assert.equal(cfg.maxFileSizeKB, DEFAULT_CONFIG.maxFileSizeKB);
  assert.equal(cfg.gitTimeoutMs, DEFAULT_CONFIG.gitTimeoutMs);
  assert.deepEqual(cfg.pathRewrite, [{ from: '/x', to: '/y' }]);
  assert.equal(normalizeNonNegativeInteger(-1, 3), 3);
});

test('excludes: plain name is segment-exact; globs support nested; no substring false positive', () => {
  const merged = mergeExcludes(['package-lock.json', '*.lock', '**/secret/**'], []);
  assert.equal(shouldExclude('src/package-lock.json', merged), true);
  assert.equal(shouldExclude('package-lock.json', merged), true);
  assert.equal(shouldExclude('my-package-lock.json.bak', merged), false);
  assert.equal(shouldExclude('src/my-package-lock.json.bak', merged), false);
  assert.equal(shouldExclude('deps/yarn.lock', merged), true);
  assert.equal(shouldExclude('a/secret/x.txt', merged), true);
  assert.equal(shouldExclude('src/app.js', merged), false);
  assert.equal(shouldExclude('src/node_modules/x.js', merged), true);
});

test('makeTree keeps structured status comments and literal  #  in filenames', () => {
  const tree = makeTree([
    { path: 'src/a.ts', comment: 'modified' },
    { path: 'src/b.ts', comment: 'renamed from src/old.ts' },
    { path: 'src/file  # weird.ts' },
  ]);
  assert.match(tree, /a\.ts {2}# modified/);
  assert.match(tree, /renamed from src\/old\.ts/);
  assert.match(tree, /file {2}# weird\.ts/);
  assert.doesNotMatch(tree, /file {2}# weird\.ts {2}#/);
});

test('makeTree escapes rename oldPath once at the tree-render boundary', () => {
  const newlineLabel = statusLabel({
    status: 'R100',
    path: 'safe.ts',
    oldPath: 'secret\nold.ts',
  });
  assert.equal(newlineLabel, 'renamed from secret\nold.ts');
  assert.equal(
    makeTree([{ path: 'safe.ts', comment: newlineLabel }]),
    'safe.ts  # renamed from secret\\nold.ts',
  );

  const tabLabel = statusLabel({
    status: 'C100',
    path: 'dst.ts',
    oldPath: 'src/\told.ts',
  });
  assert.equal(tabLabel, 'copied from src/\told.ts');
  assert.equal(
    makeTree([{ path: 'dst.ts', comment: tabLabel }]),
    'dst.ts  # copied from src/\\told.ts',
  );
});

test('rename/copy excludes when either old or new path matches', () => {
  assert.equal(
    shouldExcludeDiffEntry({ path: 'public/new.ts', oldPath: 'secret/old.ts' }, '/repo', [
      'secret/**',
    ]),
    true,
  );
  assert.equal(
    shouldExcludeDiffEntry({ path: 'secret/new.ts', oldPath: 'public/old.ts' }, '/repo', [
      'secret/**',
    ]),
    true,
  );
  assert.equal(
    shouldExcludeDiffEntry({ path: 'public/new.ts', oldPath: 'public/old.ts' }, '/repo', [
      'secret/**',
    ]),
    false,
  );
});

test('toPosixPath is platform-aware for backslashes', () => {
  if (process.platform === 'win32') {
    assert.equal(toPosixPath('a\\b\\c.txt'), 'a/b/c.txt');
  } else {
    assert.equal(toPosixPath('a\\b.txt'), 'a\\b.txt');
    assert.equal(toPosixPath('dir/a\\b.txt'), 'dir/a\\b.txt');
  }
});

test('display escaping for control characters', () => {
  assert.equal(escapePathForDisplay('a\tb'), 'a\\tb');
  assert.equal(escapePathForDisplay('a\nb'), 'a\\nb');
  assert.equal(escapePathForDisplay('a\rb'), 'a\\rb');
  assert.equal(isProbablyBinary(Buffer.from('hello')), false);
  assert.equal(isProbablyBinary(Buffer.from([0, 1, 2, 3])), true);
  assert.equal(toDisplayPath('/ws', '/ws/src/a.ts'), 'src/a.ts');
  assert.equal(toSafePathLabel('/ws/src/a.ts', ['/ws']), 'src/a.ts');
  assert.equal(toSafePathLabel('/secret/host/path.txt', ['/ws']), 'path.txt');
  assert.equal(rewritePath('/srv/source/x', '/srv/source', '/workspace'), '/workspace/x');
  assert.equal(isPathInside('/ws', '/ws/src'), true);
  assert.equal(isPathInside('/ws', '/other'), false);
  assert.equal(isPathInside('/ws', '/ws/..foo'), true);
  assert.equal(isPathInside('/ws', '/ws/../other'), false);
  assert.equal(isPathInside('/x/repo', '/x/repository'), false);
  assert.equal(isPathInsideOrEqual('/x/repo', '/x/repo'), true);
  assert.equal(isPathInsideOrEqual('/x/repo', '/x/repo/a'), true);
  assert.equal(isPathInsideOrEqual('/x/repo', '/x/repository'), false);
});

test('NUL path parsing preserves spaces, unicode, tabs, newlines, and leading/trailing spaces', () => {
  const paths = parseNulPaths('src/你好.md\0src/my file.ts\0src/\tweird\0  padded  \0line\nend\0');
  assert.deepEqual(paths, [
    'src/你好.md',
    'src/my file.ts',
    'src/\tweird',
    '  padded  ',
    'line\nend',
  ]);

  const entries = parseNameStatusNul(
    Buffer.from('M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0'),
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.path, 'src/a.ts');
  assert.equal(entries[1]!.oldPath, 'src/old.ts');
  assert.equal(entries[1]!.path, 'src/new.ts');
  assert.equal(statusLabel(entries[1]!), 'renamed from src/old.ts');
  assert.equal(statusLabel(entries[2]!), 'deleted');
});
