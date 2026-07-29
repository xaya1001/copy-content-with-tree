import * as path from 'node:path';
import { devNull } from 'node:os';
import { shouldExclude } from '../core/excludes';
import { markSkipped, type SkipStats } from '../core/output';
import {
  canonicalizePath,
  canonicalPathsEqual,
  escapePathForDisplay,
  isPathInsideOrEqual,
  toPosixPath,
} from '../core/paths';
import { makeTree } from '../core/tree';
import {
  formatGitUserError,
  parseNameStatusNul,
  parseNulPaths,
  runGit,
  type GitNameStatusEntry,
} from './exec';
import {
  discoveryCwdForTarget,
  getRepoRoot,
  pathspecArgs,
  targetsToGitPathspecs,
  withLiteralPathspecs,
  type GitExecConfig,
} from './discovery';
import { IgnoreStack, pushGitignoreForDir } from './ignore-stack';
import * as fs from 'node:fs/promises';

export interface DiffBuildOptions {
  workspaceFolder: string;
  targetPaths: readonly string[];
  autoFetch: boolean;
  includeUntracked: boolean;
  unifiedLines: number;
  excludes: readonly string[];
  useGitignore: boolean;
  gitignoreFileName: string;
  git: GitExecConfig;
}

export interface DiffBuildResult {
  output: string;
  fileCount: number;
  filteredCount: number;
  upstream: string;
  branch: string;
}

export class EmptyDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyDiffError';
  }
}

export async function buildGitDiff(options: DiffBuildOptions): Promise<DiffBuildResult> {
  const firstTarget = options.targetPaths[0] ?? options.workspaceFolder;
  const cwd = await discoveryCwdForTarget(firstTarget);
  const repoRoot = await getRepoRoot(cwd, options.git);

  if (!repoRoot) {
    throw new Error('Selected path is not inside a Git repository.');
  }

  if (options.autoFetch) {
    await runGit(['fetch', '--prune'], {
      cwd: repoRoot,
      timeoutMs: options.git.timeoutMs,
      maxBufferBytes: options.git.maxBufferBytes,
      signal: options.git.signal,
    });
  }

  let upstream: string;
  try {
    const upstreamResult = await runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      {
        cwd: repoRoot,
        timeoutMs: options.git.timeoutMs,
        maxBufferBytes: options.git.maxBufferBytes,
        signal: options.git.signal,
      },
    );
    upstream = upstreamResult.stdout.toString('utf8').trim();
  } catch (err) {
    throw new Error(formatGitUserError(err), { cause: err });
  }

  let base: string;
  try {
    const baseResult = await runGit(['merge-base', 'HEAD', '@{u}'], {
      cwd: repoRoot,
      timeoutMs: options.git.timeoutMs,
      maxBufferBytes: options.git.maxBufferBytes,
      signal: options.git.signal,
    });
    base = baseResult.stdout.toString('utf8').trim();
  } catch (err) {
    throw new Error(formatGitUserError(err), { cause: err });
  }

  const branchResult = await runGit(['branch', '--show-current'], {
    cwd: repoRoot,
    timeoutMs: options.git.timeoutMs,
    maxBufferBytes: options.git.maxBufferBytes,
    signal: options.git.signal,
  });
  const branch = branchResult.stdout.toString('utf8').trim() || '(detached)';

  const pathspecs = await targetsToGitPathspecs(options.targetPaths, repoRoot);
  const pathArgs = pathspecArgs(pathspecs);
  const filterStats: SkipStats = { skipped: 0, skippedReasons: {} };

  const nameStatusResult = await runGit(
    withLiteralPathspecs(['diff', '--name-status', '-z', '--find-renames', base, ...pathArgs]),
    {
      cwd: repoRoot,
      timeoutMs: options.git.timeoutMs,
      maxBufferBytes: options.git.maxBufferBytes,
      signal: options.git.signal,
    },
  );
  const rawTrackedStatus = parseNameStatusNul(nameStatusResult.stdout);

  const rawUntracked = options.includeUntracked
    ? parseNulPaths(
        (
          await runGit(
            withLiteralPathspecs(['ls-files', '-z', '--others', '--exclude-standard', ...pathArgs]),
            {
              cwd: repoRoot,
              timeoutMs: options.git.timeoutMs,
              maxBufferBytes: options.git.maxBufferBytes,
              signal: options.git.signal,
            },
          )
        ).stdout,
      )
    : [];

  const gitignoreStack = new IgnoreStack();
  if (options.useGitignore && options.includeUntracked) {
    await pushGitignoreForDir(gitignoreStack, repoRoot, repoRoot, options.gitignoreFileName);
    for (const spec of pathspecs) {
      const abs = path.join(repoRoot, spec);
      try {
        const st = await fs.lstat(abs);
        const dir = st.isDirectory() ? abs : path.dirname(abs);
        if (path.resolve(dir) !== path.resolve(repoRoot)) {
          await loadAncestorGitignores(gitignoreStack, repoRoot, dir, options.gitignoreFileName);
        }
      } catch {
        // ignore missing pathspec targets
      }
    }
  }

  const trackedFiltered = filterDiffEntries(
    rawTrackedStatus,
    repoRoot,
    options.excludes,
    filterStats,
  );
  const untrackedFiltered = filterDiffPaths(
    rawUntracked,
    repoRoot,
    options.excludes,
    options.useGitignore ? gitignoreStack : null,
    filterStats,
  );

  const statusByPath = buildStatusByPath(trackedFiltered, untrackedFiltered);
  const nameOnly = [...new Set([...trackedFiltered.map((e) => e.path), ...untrackedFiltered])].sort(
    (a, b) => a.localeCompare(b),
  );

  // One tracked diff so renames keep old/new path semantics together.
  let trackedDiff = '';
  if (trackedFiltered.length > 0) {
    const trackedPaths = uniqueDiffPathArgs(trackedFiltered);
    const diffResult = await runGit(
      withLiteralPathspecs([
        'diff',
        '--no-ext-diff',
        '--find-renames',
        `--unified=${options.unifiedLines}`,
        base,
        ...pathspecArgs(trackedPaths),
      ]),
      {
        cwd: repoRoot,
        timeoutMs: options.git.timeoutMs,
        maxBufferBytes: options.git.maxBufferBytes,
        signal: options.git.signal,
      },
    );
    trackedDiff = diffResult.stdout.toString('utf8').trimEnd();
  }

  const untrackedDiffs: string[] = [];
  for (const file of untrackedFiltered) {
    const result = await runGit(
      withLiteralPathspecs([
        'diff',
        '--no-ext-diff',
        '--no-index',
        `--unified=${options.unifiedLines}`,
        '--',
        // Portable empty file for `git diff --no-index` (NUL on Windows, /dev/null elsewhere).
        devNull,
        file,
      ]),
      {
        cwd: repoRoot,
        timeoutMs: options.git.timeoutMs,
        maxBufferBytes: options.git.maxBufferBytes,
        signal: options.git.signal,
        allowedExitCodes: [0, 1],
      },
    );
    const text = result.stdout.toString('utf8').trimEnd();
    if (text) untrackedDiffs.push(text);
  }

  const diff = [trackedDiff, ...untrackedDiffs].filter(Boolean).join('\n\n');
  if (!diff.trim()) {
    const scope = pathspecs.length
      ? ` for ${pathspecs.map((p) => escapePathForDisplay(p)).join(', ')}`
      : '';
    const suffix = filterStats.skipped ? ` after filtering ${filterStats.skipped} path(s)` : '';
    throw new EmptyDiffError(`no diff against ${upstream}${scope}${suffix}`);
  }

  const repoLabel = await safeRepoLabel(options.workspaceFolder, repoRoot);
  const tree = makeTree(
    nameOnly.map((file) => ({
      path: file,
      comment: statusByPath.get(file),
    })),
  );

  const lines = [
    '### git diff',
    `repo: ${escapePathForDisplay(repoLabel)}`,
    `branch: ${escapePathForDisplay(branch)}`,
    `upstream: ${escapePathForDisplay(upstream)}`,
    `base: ${escapePathForDisplay(base)}`,
    `scope: ${pathspecs.length ? pathspecs.map((p) => escapePathForDisplay(p)).join(', ') : '.'}`,
    `includeUntracked: ${options.includeUntracked}`,
    `unifiedLines: ${options.unifiedLines}`,
    `filters: tracked=exclude/blacklist, untracked=exclude/blacklist${options.useGitignore ? '/gitignore' : ''}`,
    `fileCounts: rawTracked=${rawTrackedStatus.length}, rawUntracked=${rawUntracked.length}, filtered=${filterStats.skipped}, unique=${nameOnly.length}`,
    '',
    '### changed files',
    tree,
    '',
    '### diff',
    diff,
  ];

  return {
    output: lines.join('\n'),
    fileCount: nameOnly.length,
    filteredCount: filterStats.skipped,
    upstream,
    branch,
  };
}

async function safeRepoLabel(workspaceFolder: string, repoRoot: string): Promise<string> {
  const canonicalWorkspace = await canonicalizePath(workspaceFolder);
  const canonicalRepo = await canonicalizePath(repoRoot);
  if (canonicalPathsEqual(canonicalWorkspace, canonicalRepo)) return '.';
  const relative = toPosixPath(path.relative(canonicalWorkspace, canonicalRepo));
  if (relative && !relative.startsWith('../') && relative !== '..') return relative;
  return path.basename(repoRoot);
}

function uniqueDiffPathArgs(entries: readonly GitNameStatusEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.oldPath && !paths.includes(entry.oldPath)) paths.push(entry.oldPath);
    if (entry.path && !paths.includes(entry.path)) paths.push(entry.path);
  }
  return paths;
}

function isExcludedDiffPath(
  rawPath: string,
  repoRoot: string,
  excludes: readonly string[],
): boolean {
  const displayPath = toPosixPath(rawPath).replace(/^\/+/, '');
  const absolutePath = path.join(repoRoot, displayPath);
  return shouldExclude(displayPath, excludes) || shouldExclude(absolutePath, excludes);
}

/** True when either side of a rename/copy (or the single path) matches exclude/blacklist. */
export function shouldExcludeDiffEntry(
  entry: Pick<GitNameStatusEntry, 'path' | 'oldPath'>,
  repoRoot: string,
  excludes: readonly string[],
): boolean {
  if (isExcludedDiffPath(entry.path, repoRoot, excludes)) return true;
  if (entry.oldPath && isExcludedDiffPath(entry.oldPath, repoRoot, excludes)) return true;
  return false;
}

function filterDiffEntries(
  entries: readonly GitNameStatusEntry[],
  repoRoot: string,
  excludes: readonly string[],
  stats: SkipStats,
): GitNameStatusEntry[] {
  const out: GitNameStatusEntry[] = [];
  for (const entry of entries) {
    if (shouldExcludeDiffEntry(entry, repoRoot, excludes)) {
      markSkipped(stats, 'excluded');
      continue;
    }
    out.push({
      ...entry,
      path: toPosixPath(entry.path).replace(/^\/+/, ''),
      oldPath: entry.oldPath ? toPosixPath(entry.oldPath) : null,
    });
  }
  return out;
}

function filterDiffPaths(
  paths: readonly string[],
  repoRoot: string,
  excludes: readonly string[],
  gitignoreStack: IgnoreStack | null,
  stats: SkipStats,
): string[] {
  const out: string[] = [];
  for (const rawPath of paths) {
    const displayPath = toPosixPath(rawPath).replace(/^\/+/, '');
    if (isExcludedDiffPath(rawPath, repoRoot, excludes)) {
      markSkipped(stats, 'excluded');
      continue;
    }
    if (gitignoreStack?.ignores(displayPath, false)) {
      markSkipped(stats, 'gitignored');
      continue;
    }
    if (!out.includes(displayPath)) out.push(displayPath);
  }
  return out;
}

function buildStatusByPath(
  trackedStatusItems: readonly GitNameStatusEntry[],
  untrackedPaths: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of trackedStatusItems) {
    map.set(item.path, statusLabel(item));
  }
  for (const file of untrackedPaths) {
    map.set(file, 'new');
  }
  return map;
}

export function statusLabel(item: GitNameStatusEntry): string {
  const status = String(item.status || '');
  if (status.startsWith('R')) {
    return item.oldPath ? `renamed from ${item.oldPath}` : 'renamed';
  }
  if (status.startsWith('C')) {
    return item.oldPath ? `copied from ${item.oldPath}` : 'copied';
  }
  if (status.includes('D')) return 'deleted';
  if (status.includes('A')) return 'new';
  if (status.includes('M')) return 'modified';
  if (status.includes('T')) return 'type changed';
  if (status.includes('U')) return 'unmerged';
  return status ? `status ${status}` : 'modified';
}

async function loadAncestorGitignores(
  stack: IgnoreStack,
  repoRoot: string,
  targetDir: string,
  fileName: string,
): Promise<void> {
  const root = path.resolve(repoRoot);
  let current = path.resolve(targetDir);
  const dirs: string[] = [];
  while (isPathInsideOrEqual(root, current) && path.resolve(current) !== root) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of dirs.reverse()) {
    await pushGitignoreForDir(stack, repoRoot, dir, fileName);
  }
}
