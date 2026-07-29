import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, type ExtensionConfig } from '../src/core/config';
import { escapePathForDisplay, toPosixPath } from '../src/core/paths';
import { makeTree } from '../src/core/tree';
import { buildCopyContent, buildCopyTree } from '../src/commands/build';
import { collectFiles } from '../src/fs/walk';
import { IgnoreStack, pushGitignoreForDir } from '../src/git/ignore-stack';

const NS = 'cwt';

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${NS}-${prefix}`));
}

function baseConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    ...DEFAULT_CONFIG,
    exclude: [],
    blacklist: [],
    useGitignore: true,
    pathRewrite: [],
    ...overrides,
  };
}

/** Create a symlink; skip only on genuine Windows privilege failures. */
async function symlinkOrSkip(
  t: { skip: (msg?: string) => void },
  target: string,
  linkPath: string,
  type?: 'file' | 'dir' | 'junction',
): Promise<boolean> {
  try {
    const linkType = type ?? (process.platform === 'win32' ? 'file' : undefined);
    if (linkType) {
      await fs.symlink(target, linkPath, linkType);
    } else {
      await fs.symlink(target, linkPath);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      t.skip(
        `symlinks unavailable on this Windows host (${code}); enable Developer Mode or run elevated`,
      );
      return false;
    }
    throw err;
  }
}

test('Copy Tree copies filtered paths without file contents', async () => {
  const root = await makeTemp('copy-tree-');
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'ignored-package'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'README_CONTENT_MUST_NOT_BE_COPIED');
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'APP_CONTENT_MUST_NOT_BE_COPIED');
    await fs.writeFile(
      path.join(root, 'node_modules', 'ignored-package', 'index.js'),
      'IGNORED_CONTENT',
    );

    const result = await buildCopyTree({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({ useGitignore: false }),
      allowGit: true,
    });

    assert.equal(result.output, '### tree\nsrc/\n  app.js\nREADME.md');
    assert.doesNotMatch(result.output, /CONTENT_MUST_NOT_BE_COPIED|IGNORED_CONTENT|node_modules/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Copy Content includes tree and file bodies', async () => {
  const root = await makeTemp('copy-content-');
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'console.log(1);\n');

    const result = await buildCopyContent({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({ useGitignore: false }),
      allowGit: true,
    });

    assert.match(result.output, /### tree\nsrc\/\n {2}app\.js/);
    assert.match(result.output, /### src\/app\.js\nconsole\.log\(1\);/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('non-git nested .gitignore is applied when selecting root', async () => {
  const root = await makeTemp('nested-gitignore-');
  try {
    await fs.mkdir(path.join(root, 'pkg', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'root-secret.txt\n');
    await fs.writeFile(path.join(root, 'pkg', '.gitignore'), 'nested-secret.txt\n');
    await fs.writeFile(path.join(root, 'visible.txt'), 'ok');
    await fs.writeFile(path.join(root, 'root-secret.txt'), 'nope');
    await fs.writeFile(path.join(root, 'pkg', 'nested-secret.txt'), 'nope');
    await fs.writeFile(path.join(root, 'pkg', 'nested', 'keep.txt'), 'yes');

    const result = await buildCopyTree({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({ useGitignore: true }),
      allowGit: false,
    });

    assert.match(result.output, /visible\.txt/);
    assert.match(result.output, /keep\.txt/);
    assert.doesNotMatch(result.output, /root-secret|nested-secret/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('IgnoreStack last match wins across nested layers', async () => {
  const root = await makeTemp('ignore-stack-');
  try {
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), '*.log\n');
    await fs.writeFile(path.join(root, 'sub', '.gitignore'), '!keep.log\n');

    const stack = new IgnoreStack();
    await pushGitignoreForDir(stack, root, root, '.gitignore');
    await pushGitignoreForDir(stack, root, path.join(root, 'sub'), '.gitignore');

    assert.equal(stack.ignores('drop.log', false), true);
    assert.equal(stack.ignores('sub/keep.log', false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unicode, spaces, tab, trailing newline, and literal  #  filenames', async () => {
  const root = await makeTemp('special-names-');
  try {
    await fs.writeFile(path.join(root, '你好 世界.md'), '# hi\n');
    await fs.writeFile(path.join(root, 'my file.ts'), 'x\n');
    await fs.writeFile(path.join(root, 'file  # weird.ts'), 'y\n');
    const tabName = `tab${'\t'}name.ts`;
    await fs.writeFile(path.join(root, tabName), 't\n');
    const spaced = '  padded  .txt';
    await fs.writeFile(path.join(root, spaced), 'p\n');
    const newlineName = `line${'\n'}end.ts`;
    let wroteNewline = false;
    try {
      await fs.writeFile(path.join(root, newlineName), 'n\n');
      wroteNewline = true;
    } catch {
      // Some platforms reject newline in filenames; still assert display escaping.
    }

    const result = await buildCopyContent({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({ useGitignore: false }),
      allowGit: false,
    });

    assert.match(result.output, /你好 世界\.md/);
    assert.match(result.output, /my file\.ts/);
    assert.match(result.output, /file {2}# weird\.ts/);
    assert.match(result.output, new RegExp(escapePathForDisplay(tabName).replace(/\\/g, '\\\\')));
    assert.match(result.output, / {2}padded {2}\.txt/);
    if (wroteNewline) {
      assert.match(result.output, /line\\nend\.ts/);
    }
    assert.equal(escapePathForDisplay(newlineName), 'line\\nend.ts');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX literal backslash filename stays one path segment', async (t) => {
  if (process.platform === 'win32') {
    t.skip('backslash is the path separator on Windows');
    return;
  }

  const root = await makeTemp('backslash-name-');
  const fileName = 'a\\b.txt';
  try {
    await fs.writeFile(path.join(root, fileName), 'backslash-body\n');

    assert.equal(toPosixPath(fileName), fileName);
    assert.equal(toPosixPath(`dir/${fileName}`), `dir/${fileName}`);

    const treeOnly = makeTree([{ path: fileName }]);
    assert.equal(treeOnly, escapePathForDisplay(fileName));
    assert.doesNotMatch(treeOnly, /^a\/$/m);

    const result = await buildCopyContent({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({ useGitignore: false }),
      allowGit: false,
    });

    assert.match(result.output, /backslash-body/);
    assert.match(result.output, new RegExp(escapePathForDisplay(fileName).replace(/\\/g, '\\\\')));
    assert.doesNotMatch(result.output, /\na\/\n/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('binary and large files are skipped; output limit enforced', async () => {
  const root = await makeTemp('limits-');
  try {
    await fs.writeFile(path.join(root, 'ok.txt'), 'hello');
    await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 4]));
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(4096));

    const skipped = await buildCopyContent({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({
        useGitignore: false,
        maxFileSizeKB: 1,
        includeSkippedInTree: true,
      }),
      allowGit: false,
    });
    assert.match(skipped.output, /ok\.txt/);
    assert.match(skipped.output, /skipped: binary|skipped: too large/);

    await assert.rejects(
      () =>
        buildCopyContent({
          workspaceFolder: root,
          targets: [{ fsPath: root }],
          config: baseConfig({ useGitignore: false, maxOutputChars: 20 }),
          allowGit: false,
        }),
      /too large/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('internal file symlink followed; directory and broken skipped; external refused', async (t) => {
  const root = await makeTemp('symlink-');
  const outside = await makeTemp('symlink-outside-');
  try {
    await fs.writeFile(path.join(root, 'target.txt'), 'inside');
    await fs.writeFile(path.join(outside, 'external.txt'), 'outside');
    if (!(await symlinkOrSkip(t, path.join(root, 'target.txt'), path.join(root, 'link.txt')))) {
      return;
    }
    if (!(await symlinkOrSkip(t, path.join(root, 'missing.txt'), path.join(root, 'broken.txt')))) {
      return;
    }
    await fs.mkdir(path.join(root, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(root, 'subdir', 'x.txt'), 'x');
    if (!(await symlinkOrSkip(t, path.join(root, 'subdir'), path.join(root, 'dirlink'), 'dir'))) {
      return;
    }
    if (!(await symlinkOrSkip(t, path.join(outside, 'external.txt'), path.join(root, 'ext.txt')))) {
      return;
    }

    const collected = await collectFiles({
      workspaceFolder: root,
      targetPaths: [root],
      excludes: [],
      useGitignore: false,
      allowGit: false,
      gitignoreFileName: '.gitignore',
      includeSkippedInTree: true,
      followFileSymlinks: true,
      allowExternalSymlinkTargets: false,
      pathRewrite: [],
      git: { timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 },
    });

    const names = collected.files.map((f) => f.displayPath).sort();
    assert.ok(names.includes('link.txt'));
    assert.ok(names.includes('target.txt'));
    assert.ok(!names.includes('ext.txt'));
    assert.ok(!names.includes('dirlink'));
    assert.ok(collected.skippedTreeItems.some((s) => s.path === 'broken.txt'));
    assert.ok(collected.skippedTreeItems.some((s) => s.path === 'ext.txt'));
    assert.ok(collected.skippedTreeItems.some((s) => s.path === 'dirlink'));

    const link = collected.files.find((f) => f.displayPath === 'link.txt')!;
    assert.equal(link.isSymlink, true);
    assert.match(link.symlinkNote, /symlink target:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('allowExternalSymlinkTargets opt-in follows outside targets', async (t) => {
  const root = await makeTemp('symlink-ext-');
  const outside = await makeTemp('symlink-ext-out-');
  try {
    await fs.writeFile(path.join(outside, 'external.txt'), 'outside');
    if (!(await symlinkOrSkip(t, path.join(outside, 'external.txt'), path.join(root, 'ext.txt')))) {
      return;
    }

    const collected = await collectFiles({
      workspaceFolder: root,
      targetPaths: [root],
      excludes: [],
      useGitignore: false,
      allowGit: false,
      gitignoreFileName: '.gitignore',
      includeSkippedInTree: false,
      followFileSymlinks: true,
      allowExternalSymlinkTargets: true,
      pathRewrite: [],
      git: { timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 },
    });

    assert.ok(collected.files.some((f) => f.displayPath === 'ext.txt'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('untrusted allowGit=false never invokes Git even with useGitignore', async () => {
  const root = await makeTemp('untrusted-');
  const fakeBin = await makeTemp('fake-git-bin-');
  const marker = path.join(fakeBin, 'git-was-called');
  const previousPath = process.env.PATH;
  try {
    const script =
      process.platform === 'win32'
        ? `@echo off\r\necho called> "${marker}"\r\nexit /b 1\r\n`
        : `#!/bin/sh\necho called > "${marker.replace(/"/g, '')}"\nexit 1\n`;
    const gitName = process.platform === 'win32' ? 'git.cmd' : 'git';
    await fs.writeFile(path.join(fakeBin, gitName), script);
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(fakeBin, gitName), 0o755);
    }
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`;

    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'secret.txt\n');
    await fs.writeFile(path.join(root, 'sub', '.gitignore'), 'nested.txt\n');
    await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
    await fs.writeFile(path.join(root, 'secret.txt'), 'no');
    await fs.writeFile(path.join(root, 'sub', 'nested.txt'), 'no');
    await fs.writeFile(path.join(root, 'sub', 'keep.txt'), 'yes');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });

    const result = await buildCopyTree({
      workspaceFolder: root,
      targets: [{ fsPath: root }],
      config: baseConfig({ useGitignore: true }),
      allowGit: false,
    });

    assert.equal(
      await fs.access(marker).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.match(result.output, /ok\.txt/);
    assert.match(result.output, /keep\.txt/);
    assert.doesNotMatch(result.output, /secret\.txt|nested\.txt/);
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});
