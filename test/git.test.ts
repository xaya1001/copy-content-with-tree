import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, type ExtensionConfig } from '../src/core/config';
import {
  buildCopyContent,
  buildCopyDiff,
  buildCopyTree,
  EmptyDiffError,
} from '../src/commands/build';
import { canonicalizePath, escapePathForDisplay } from '../src/core/paths';
import { collectFiles } from '../src/fs/walk';
import {
  discoverGitRepos,
  getRepoRoot,
  toLiteralPathspec,
  targetsToGitPathspecs,
} from '../src/git/discovery';
import {
  OperationCancelledError,
  parseNameStatusNul,
  runGit,
  isCancellationError,
  GitNotFoundError,
  GitCommandError,
} from '../src/git/exec';

const NS = 'cwt';

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${NS}-${prefix}`));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function baseConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    ...DEFAULT_CONFIG,
    exclude: [],
    blacklist: [],
    useGitignore: true,
    pathRewrite: [],
    diffAutoFetch: false,
    ...overrides,
  };
}

async function initRepoWithUpstream(root: string): Promise<void> {
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await fs.mkdir(work, { recursive: true });
  git(root, ['init', '--bare', bare]);
  git(work, ['init']);
  git(work, ['checkout', '-b', 'main']);
  await fs.writeFile(path.join(work, 'README.md'), 'base\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-m', 'init']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-u', 'origin', 'main']);
}

test('git repo: tracked-but-ignored file is included; ignored untracked excluded', async () => {
  const root = await makeTemp('git-ignored-');
  const work = path.join(root, 'work');
  try {
    await fs.mkdir(work, { recursive: true });
    git(work, ['init']);
    await fs.writeFile(path.join(work, '.gitignore'), 'secret.txt\nbuild/\n');
    await fs.writeFile(path.join(work, 'secret.txt'), 'tracked-secret\n');
    await fs.writeFile(path.join(work, 'keep.txt'), 'keep\n');
    git(work, ['add', '-f', 'secret.txt', 'keep.txt', '.gitignore']);
    git(work, ['commit', '-m', 'init']);
    await fs.mkdir(path.join(work, 'build'), { recursive: true });
    await fs.writeFile(path.join(work, 'build', 'out.js'), 'nope\n');
    await fs.writeFile(path.join(work, 'other.log'), 'untracked-ignored-ish\n');
    await fs.appendFile(path.join(work, '.gitignore'), '*.log\n');

    const result = await buildCopyTree({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig(),
      allowGit: true,
    });

    assert.match(result.output, /secret\.txt/);
    assert.match(result.output, /keep\.txt/);
    assert.doesNotMatch(result.output, /out\.js|other\.log/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('git nested .gitignore under selected root excludes untracked files', async () => {
  const root = await makeTemp('git-nested-gi-');
  const work = path.join(root, 'work');
  try {
    await fs.mkdir(path.join(work, 'pkg'), { recursive: true });
    git(work, ['init']);
    await fs.writeFile(path.join(work, 'pkg', '.gitignore'), 'hidden.txt\n');
    await fs.writeFile(path.join(work, 'pkg', 'visible.txt'), 'yes\n');
    await fs.writeFile(path.join(work, 'pkg', 'hidden.txt'), 'no\n');
    git(work, ['add', 'pkg/visible.txt', 'pkg/.gitignore']);
    git(work, ['commit', '-m', 'init']);

    const result = await buildCopyTree({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig(),
      allowGit: true,
    });

    assert.match(result.output, /visible\.txt/);
    assert.doesNotMatch(result.output, /hidden\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copy diff: modified deleted staged-new rename untracked and excluded', async () => {
  const root = await makeTemp('git-diff-');
  try {
    await initRepoWithUpstream(root);
    const work = path.join(root, 'work');

    await fs.writeFile(path.join(work, 'README.md'), 'changed\n');
    await fs.writeFile(path.join(work, 'gone.txt'), 'bye\n');
    await fs.writeFile(path.join(work, 'old-name.ts'), 'rename-me\n');
    await fs.writeFile(path.join(work, 'skip-me.lock'), 'lock\n');
    git(work, ['add', 'gone.txt', 'old-name.ts', 'skip-me.lock']);
    git(work, ['commit', '-m', 'add files']);
    git(work, ['push']);

    await fs.rm(path.join(work, 'gone.txt'));
    git(work, ['mv', 'old-name.ts', 'new-name.ts']);
    await fs.writeFile(path.join(work, 'staged-new.ts'), 'staged\n');
    git(work, ['add', 'staged-new.ts', 'new-name.ts']);
    await fs.writeFile(path.join(work, 'untracked.ts'), 'u\n');
    await fs.writeFile(path.join(work, 'skip-me.lock'), 'lock2\n');
    await fs.writeFile(path.join(work, 'README.md'), 'changed-again\n');

    const result = await buildCopyDiff({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig({
        blacklist: ['*.lock'],
        diffIncludeUntracked: true,
        diffUnifiedLines: 0,
      }),
      allowGit: true,
    });

    assert.match(result.output, /### git diff/);
    assert.match(result.output, /repo: \./);
    assert.match(result.output, /# modified|# deleted|# new|# renamed from/);
    assert.match(result.output, /renamed from old-name\.ts/);
    assert.match(result.output, /diff --git a\/old-name\.ts b\/new-name\.ts/);
    assert.match(result.output, /untracked\.ts/);
    assert.match(result.output, /staged-new\.ts/);
    assert.doesNotMatch(result.output, /skip-me\.lock/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copy diff: chinese and space path rename via -z', async () => {
  const root = await makeTemp('git-unicode-diff-');
  try {
    await initRepoWithUpstream(root);
    const work = path.join(root, 'work');
    await fs.writeFile(path.join(work, '你好 old.ts'), 'body\n');
    git(work, ['add', '你好 old.ts']);
    git(work, ['commit', '-m', 'add unicode']);
    git(work, ['push']);
    git(work, ['mv', '你好 old.ts', '你好 new.ts']);
    git(work, ['commit', '-m', 'rename unicode']);

    const result = await buildCopyDiff({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig(),
      allowGit: true,
    });

    assert.match(result.output, /你好 new\.ts/);
    assert.match(result.output, /renamed from 你好 old\.ts/);
    assert.match(result.output, /diff --git/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copy diff without upstream is actionable', async () => {
  const root = await makeTemp('git-noupstream-');
  const work = path.join(root, 'work');
  try {
    await fs.mkdir(work, { recursive: true });
    git(work, ['init']);
    git(work, ['checkout', '-b', 'main']);
    await fs.writeFile(path.join(work, 'a.txt'), 'a\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'init']);

    await assert.rejects(
      () =>
        buildCopyDiff({
          workspaceFolder: work,
          targets: [{ fsPath: work }],
          config: baseConfig(),
          allowGit: true,
        }),
      /upstream/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('empty diff against upstream reports EmptyDiffError', async () => {
  const root = await makeTemp('git-emptydiff-');
  try {
    await initRepoWithUpstream(root);
    const work = path.join(root, 'work');
    await assert.rejects(
      () =>
        buildCopyDiff({
          workspaceFolder: work,
          targets: [{ fsPath: work }],
          config: baseConfig(),
          allowGit: true,
        }),
      (err: unknown) => err instanceof EmptyDiffError,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('selected target inside nested repo is discovered without scanning siblings', async () => {
  const root = await makeTemp('git-nested-repo-');
  const parent = path.join(root, 'parent');
  const child = path.join(parent, 'child');
  try {
    await fs.mkdir(child, { recursive: true });
    git(parent, ['init']);
    await fs.writeFile(path.join(parent, 'p.txt'), 'p\n');
    git(parent, ['add', 'p.txt']);
    git(parent, ['commit', '-m', 'parent']);

    git(child, ['init']);
    await fs.writeFile(path.join(child, 'c.txt'), 'c\n');
    git(child, ['add', 'c.txt']);
    git(child, ['commit', '-m', 'child']);

    const fromChild = await discoverGitRepos(parent, [child], {
      timeoutMs: 15_000,
      maxBufferBytes: 1024 * 1024,
    });
    const childCanon = await canonicalizePath(child);
    const parentCanon = await canonicalizePath(parent);
    assert.ok(fromChild.roots.some((r) => r === childCanon));
    assert.ok(!fromChild.roots.some((r) => r === parentCanon));
    assert.equal(fromChild.coveredTargets.get(childCanon), childCanon);

    const fromParent = await discoverGitRepos(parent, [parent], {
      timeoutMs: 15_000,
      maxBufferBytes: 1024 * 1024,
    });
    assert.ok(fromParent.roots.some((r) => r === parentCanon));
    assert.ok(!fromParent.roots.some((r) => r === childCanon));

    const tree = await buildCopyTree({
      workspaceFolder: parent,
      targets: [{ fsPath: child }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.match(tree.output, /c\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('name-status -z parse keeps rename pair for patch path args', () => {
  const entries = parseNameStatusNul('R100\0src/a b.ts\0src/a 新.ts\0');
  assert.equal(entries[0]!.oldPath, 'src/a b.ts');
  assert.equal(entries[0]!.path, 'src/a 新.ts');
});

test('copy content in git repo reads file bodies', async () => {
  const root = await makeTemp('git-content-');
  const work = path.join(root, 'work');
  try {
    await fs.mkdir(work, { recursive: true });
    git(work, ['init']);
    await fs.writeFile(path.join(work, 'app.ts'), 'export {}\n');
    git(work, ['add', 'app.ts']);
    git(work, ['commit', '-m', 'init']);

    const collected = await collectFiles({
      workspaceFolder: work,
      targetPaths: [work],
      excludes: [],
      useGitignore: true,
      allowGit: true,
      gitignoreFileName: '.gitignore',
      includeSkippedInTree: false,
      followFileSymlinks: true,
      allowExternalSymlinkTargets: false,
      pathRewrite: [],
      git: { timeoutMs: 15_000, maxBufferBytes: 1024 * 1024 },
    });
    assert.ok(collected.files.some((f) => f.displayPath === 'app.ts'));

    const content = await buildCopyContent({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.match(content.output, /export \{\}/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runGit abort propagates OperationCancelledError and isCancellationError', async () => {
  const root = await makeTemp('git-cancel-');
  try {
    git(root, ['init']);
    const controller = new AbortController();
    const pending = runGit(['status'], {
      cwd: root,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(isCancellationError(err));
      assert.ok(err instanceof OperationCancelledError);
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('buildCopyDiff rejects when allowGit is false', async () => {
  await assert.rejects(
    () =>
      buildCopyDiff({
        workspaceFolder: os.tmpdir(),
        targets: [{ fsPath: os.tmpdir() }],
        config: baseConfig(),
        allowGit: false,
      }),
    /trusted workspace/i,
  );
});

test('untracked patch uses portable os.devNull', async () => {
  const root = await makeTemp('git-devnull-');
  try {
    await initRepoWithUpstream(root);
    const work = path.join(root, 'work');
    await fs.writeFile(path.join(work, 'untracked-null-device.ts'), 'hello-null\n');

    const result = await buildCopyDiff({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig({ diffIncludeUntracked: true }),
      allowGit: true,
    });

    assert.match(result.output, /untracked-null-device\.ts/);
    assert.match(result.output, /\+hello-null/);
    // Git may display the left side as /dev/null or NUL depending on platform/version.
    assert.match(result.output, /\/dev\/null|\bNUL\b/i);
    assert.equal(os.devNull, process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POSIX git path with literal backslash stays a single file in tree/content', async (t) => {
  if (process.platform === 'win32') {
    t.skip('backslash is the path separator on Windows');
    return;
  }

  const root = await makeTemp('git-backslash-');
  const work = path.join(root, 'work');
  const fileName = 'a\\b.txt';
  try {
    await fs.mkdir(work, { recursive: true });
    git(work, ['init']);
    await fs.writeFile(path.join(work, fileName), 'slash-body\n');
    git(work, ['add', fileName]);
    git(work, ['commit', '-m', 'add backslash name']);

    const tree = await buildCopyTree({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.match(tree.output, new RegExp(escapePathForDisplay(fileName).replace(/\\/g, '\\\\')));
    assert.doesNotMatch(tree.output, /\na\/\n/);

    const content = await buildCopyContent({
      workspaceFolder: work,
      targets: [{ fsPath: work }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.match(content.output, /slash-body/);
    assert.match(content.output, new RegExp(escapePathForDisplay(fileName).replace(/\\/g, '\\\\')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('collectFiles keeps uncovered filesystem targets when selection mixes git and non-git', async () => {
  const root = await makeTemp('git-mixed-');
  const repo = path.join(root, 'repo');
  const plain = path.join(root, 'plain');
  try {
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(plain, { recursive: true });
    git(repo, ['init']);
    await fs.writeFile(path.join(repo, 'in-repo.ts'), 'from-repo\n');
    git(repo, ['add', 'in-repo.ts']);
    git(repo, ['commit', '-m', 'init']);
    await fs.writeFile(path.join(plain, 'outside.ts'), 'from-plain\n');

    const collected = await collectFiles({
      workspaceFolder: root,
      targetPaths: [repo, plain],
      excludes: [],
      useGitignore: true,
      allowGit: true,
      gitignoreFileName: '.gitignore',
      includeSkippedInTree: false,
      followFileSymlinks: true,
      allowExternalSymlinkTargets: false,
      pathRewrite: [],
      git: { timeoutMs: 15_000, maxBufferBytes: 1024 * 1024 },
    });

    const names = collected.files.map((f) => f.displayPath);
    assert.ok(
      names.some((n) => n === 'repo/in-repo.ts' || n.endsWith('in-repo.ts')),
      `expected in-repo.ts in ${names.join(',')}`,
    );
    assert.ok(
      names.some((n) => n === 'plain/outside.ts' || n.endsWith('outside.ts')),
      `expected outside.ts in ${names.join(',')}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trusted collect/diff discovery propagates GitNotFound when git missing from PATH', async () => {
  const root = await makeTemp('git-notfound-');
  const emptyBin = await makeTemp('empty-bin-');
  const previousPath = process.env.PATH;
  try {
    await fs.mkdir(path.join(root, 'work'), { recursive: true });
    const work = path.join(root, 'work');
    git(work, ['init']);
    await fs.writeFile(path.join(work, 'a.ts'), 'a\n');
    git(work, ['add', 'a.ts']);
    git(work, ['commit', '-m', 'init']);

    process.env.PATH = emptyBin;

    await assert.rejects(
      () =>
        getRepoRoot(work, {
          timeoutMs: 5_000,
          maxBufferBytes: 1024 * 1024,
        }),
      (err: unknown) => err instanceof GitNotFoundError,
    );

    await assert.rejects(
      () =>
        collectFiles({
          workspaceFolder: work,
          targetPaths: [work],
          excludes: [],
          useGitignore: true,
          allowGit: true,
          gitignoreFileName: '.gitignore',
          includeSkippedInTree: false,
          followFileSymlinks: true,
          allowExternalSymlinkTargets: false,
          pathRewrite: [],
          git: { timeoutMs: 5_000, maxBufferBytes: 1024 * 1024 },
        }),
      (err: unknown) => err instanceof GitNotFoundError,
    );

    await assert.rejects(
      () =>
        buildCopyDiff({
          workspaceFolder: work,
          targets: [{ fsPath: work }],
          config: baseConfig(),
          allowGit: true,
        }),
      (err: unknown) => err instanceof GitNotFoundError,
    );
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(emptyBin, { recursive: true, force: true });
  }
});

test('collectFiles propagates ls-files GitCommandError for a covered repo target', async () => {
  const root = await makeTemp('git-lsfiles-fail-');
  const fakeBin = await makeTemp('fake-git-lsfiles-');
  const previousPath = process.env.PATH;
  try {
    const work = path.join(root, 'work');
    await fs.mkdir(work, { recursive: true });
    git(work, ['init']);
    await fs.writeFile(path.join(work, 'a.ts'), 'a\n');
    git(work, ['add', 'a.ts']);
    git(work, ['commit', '-m', 'init']);

    const shimJs = path.join(fakeBin, 'git-shim.js');
    await fs.writeFile(
      shimJs,
      [
        'const args = process.argv.slice(2);',
        'if (args.includes("ls-files")) {',
        '  console.error("simulated ls-files failure");',
        '  process.exit(128);',
        '}',
        'if (args.includes("--show-toplevel")) {',
        `  process.stdout.write(${JSON.stringify(work)} + "\\n");`,
        '  process.exit(0);',
        '}',
        'process.exit(0);',
        '',
      ].join('\n'),
    );

    if (process.platform === 'win32') {
      await fs.writeFile(
        path.join(fakeBin, 'git.cmd'),
        `@echo off\r\nnode "%~dp0git-shim.js" %*\r\n`,
      );
    } else {
      await fs.writeFile(
        path.join(fakeBin, 'git'),
        `#!/bin/sh\nexec node "$(dirname "$0")/git-shim.js" "$@"\n`,
        { mode: 0o755 },
      );
    }
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`;

    await assert.rejects(
      () =>
        collectFiles({
          workspaceFolder: work,
          targetPaths: [work],
          excludes: [],
          useGitignore: true,
          allowGit: true,
          gitignoreFileName: '.gitignore',
          includeSkippedInTree: false,
          followFileSymlinks: true,
          allowExternalSymlinkTargets: false,
          pathRewrite: [],
          git: { timeoutMs: 5_000, maxBufferBytes: 1024 * 1024 },
        }),
      (err: unknown) => err instanceof GitCommandError,
    );
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

test('POSIX literal pathspecs copy and diff exactly the magic-named file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('magic pathspec filenames are exercised on POSIX');
    return;
  }

  const magicGlob = ':(glob)*.ts';
  const magicLiteralPrefix = ':(literal)foo.ts';
  const decoyA = 'a.ts';
  const decoyFoo = 'foo.ts';
  const root = await makeTemp('git-literal-pathspec-');
  try {
    await initRepoWithUpstream(root);
    const work = path.join(root, 'work');
    await fs.writeFile(path.join(work, decoyA), 'decoy-a\n');
    await fs.writeFile(path.join(work, decoyFoo), 'decoy-foo\n');
    await fs.writeFile(path.join(work, magicGlob), 'magic-glob-only\n');
    await fs.writeFile(path.join(work, magicLiteralPrefix), 'magic-literal-prefix-only\n');
    // Fixture add must also be literal so Git does not expand magic names.
    git(work, ['--literal-pathspecs', 'add', '-A']);
    git(work, ['commit', '-m', 'add magic and decoys']);
    git(work, ['push']);

    // Always wrap, including names that already start with :(literal).
    assert.equal(toLiteralPathspec(magicGlob), `:(literal)${magicGlob}`);
    assert.equal(toLiteralPathspec(magicLiteralPrefix), `:(literal)${magicLiteralPrefix}`);
    assert.notEqual(toLiteralPathspec(magicLiteralPrefix), magicLiteralPrefix);

    // Without literal mode, ":(glob)*.ts" expands to every matching .ts pathspec.
    const nonLiteral = execFileSync('git', ['ls-files', '-z', '--', magicGlob], {
      cwd: work,
      encoding: 'buffer',
    });
    const nonLiteralPaths = nonLiteral.toString('utf8').split('\0').filter(Boolean).sort();
    assert.ok(
      nonLiteralPaths.length > 1,
      `expected non-literal pathspec to expand, got ${JSON.stringify(nonLiteralPaths)}`,
    );

    const selectedGlob = path.join(work, magicGlob);
    const tree = await buildCopyTree({
      workspaceFolder: work,
      targets: [{ fsPath: selectedGlob }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.equal(tree.output, `### tree\n${escapePathForDisplay(magicGlob)}`);
    assert.doesNotMatch(tree.output, /\ba\.ts\b|\bfoo\.ts\b/);

    const content = await buildCopyContent({
      workspaceFolder: work,
      targets: [{ fsPath: selectedGlob }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.match(content.output, /magic-glob-only/);
    assert.doesNotMatch(content.output, /decoy-a|decoy-foo|magic-literal-prefix/);
    assert.equal(content.fileCount, 1);

    await fs.writeFile(path.join(work, magicGlob), 'magic-glob-changed\n');
    const diff = await buildCopyDiff({
      workspaceFolder: work,
      targets: [{ fsPath: selectedGlob }],
      config: baseConfig({ diffIncludeUntracked: false }),
      allowGit: true,
    });
    assert.match(diff.output, /magic-glob-changed/);
    assert.match(diff.output, /^scope: :\(glob\)\*\.ts$/m);
    assert.doesNotMatch(diff.output, /decoy-a|decoy-foo|magic-literal-prefix/);
    assert.equal(diff.fileCount, 1);

    // Exact prefix edge: filename is literally ":(literal)foo.ts", not "foo.ts".
    const selectedLiteralName = path.join(work, magicLiteralPrefix);
    const literalContent = await buildCopyContent({
      workspaceFolder: work,
      targets: [{ fsPath: selectedLiteralName }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.equal(literalContent.fileCount, 1);
    assert.match(literalContent.output, /magic-literal-prefix-only/);
    assert.doesNotMatch(literalContent.output, /decoy-foo|magic-glob/);
    assert.equal(
      (
        await buildCopyTree({
          workspaceFolder: work,
          targets: [{ fsPath: selectedLiteralName }],
          config: baseConfig(),
          allowGit: true,
        })
      ).output,
      `### tree\n${escapePathForDisplay(magicLiteralPrefix)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('directory symlink alias matches Git realpath roots for pathspecs and collection', async (t) => {
  const base = await makeTemp('git-alias-base-');
  const realRoot = path.join(base, 'real-work');
  const aliasRoot = path.join(base, 'alias-work');
  try {
    await fs.mkdir(realRoot, { recursive: true });
    try {
      if (process.platform === 'win32') {
        await fs.symlink(realRoot, aliasRoot, 'junction');
      } else {
        await fs.symlink(realRoot, aliasRoot, 'dir');
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        t.skip(`symlinks unavailable on this Windows host (${code})`);
        return;
      }
      throw err;
    }

    git(realRoot, ['init']);
    await fs.writeFile(path.join(realRoot, 'app.ts'), 'export const n = 1;\n');
    await fs.mkdir(path.join(realRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(realRoot, 'src', 'nested.ts'), 'nested\n');
    git(realRoot, ['add', '-A']);
    git(realRoot, ['commit', '-m', 'init']);

    const realCanon = await canonicalizePath(realRoot);
    const aliasCanon = await canonicalizePath(aliasRoot);
    assert.equal(aliasCanon, realCanon);

    // Missing leaf under the alias still canonicalizes via the existing ancestor.
    const missingViaAlias = path.join(aliasRoot, 'deleted-never-existed.ts');
    assert.equal(
      await canonicalizePath(missingViaAlias),
      path.join(realCanon, 'deleted-never-existed.ts'),
    );

    const specs = await targetsToGitPathspecs([aliasRoot], realCanon);
    assert.deepEqual(specs, []);

    const nestedSpecs = await targetsToGitPathspecs([path.join(aliasRoot, 'src')], realCanon);
    assert.deepEqual(nestedSpecs, ['src']);

    const collected = await collectFiles({
      workspaceFolder: aliasRoot,
      targetPaths: [aliasRoot],
      excludes: [],
      useGitignore: true,
      allowGit: true,
      gitignoreFileName: '.gitignore',
      includeSkippedInTree: false,
      followFileSymlinks: true,
      allowExternalSymlinkTargets: false,
      pathRewrite: [],
      git: { timeoutMs: 15_000, maxBufferBytes: 1024 * 1024 },
    });
    const names = collected.files.map((f) => f.displayPath).sort();
    assert.ok(names.includes('app.ts'), `expected app.ts in ${names.join(',')}`);
    assert.ok(names.includes('src/nested.ts'), `expected src/nested.ts in ${names.join(',')}`);

    const content = await buildCopyContent({
      workspaceFolder: aliasRoot,
      targets: [{ fsPath: aliasRoot }],
      config: baseConfig(),
      allowGit: true,
    });
    assert.match(content.output, /export const n = 1/);
    assert.match(content.output, /### src\/nested\.ts/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
