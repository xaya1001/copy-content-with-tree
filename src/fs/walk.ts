import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PathRewriteRule } from '../core/config';
import { shouldExclude } from '../core/excludes';
import { markSkipped, type SkipStats } from '../core/output';
import { isPathInsideOrEqual, toDisplayPath, toPosixPath } from '../core/paths';
import type { TreeEntry } from '../core/tree';
import {
  discoverGitRepos,
  listGitFiles,
  targetsToGitPathspecs,
  type GitExecConfig,
} from '../git/discovery';
import { IgnoreStack, pushGitignoreForDir } from '../git/ignore-stack';
import { formatSymlinkNote, resolveReadablePath, type SymlinkPolicy } from './symlink';

export interface CollectedFile {
  displayPath: string;
  sourcePath: string;
  readPath: string;
  isSymlink: boolean;
  symlinkTarget: string | null;
  symlinkNote: string;
}

export interface CollectOptions {
  workspaceFolder: string;
  targetPaths: readonly string[];
  excludes: readonly string[];
  useGitignore: boolean;
  /** When false, never invoke Git even if useGitignore is true (untrusted workspaces). */
  allowGit: boolean;
  gitignoreFileName: string;
  includeSkippedInTree: boolean;
  followFileSymlinks: boolean;
  allowExternalSymlinkTargets: boolean;
  pathRewrite: readonly PathRewriteRule[];
  git: GitExecConfig;
}

export interface CollectResult {
  files: CollectedFile[];
  skippedTreeItems: TreeEntry[];
  stats: SkipStats;
}

function pushSkip(
  skippedTreeItems: TreeEntry[],
  include: boolean,
  displayPath: string,
  reason: string,
): void {
  if (!include) return;
  skippedTreeItems.push({ path: displayPath, comment: `skipped: ${reason}` });
}

export async function collectFiles(options: CollectOptions): Promise<CollectResult> {
  const stats: SkipStats = { skipped: 0, skippedReasons: {} };
  const skippedTreeItems: TreeEntry[] = [];
  const out: CollectedFile[] = [];

  const boundaryRoots = [options.workspaceFolder, ...options.targetPaths.map((p) => p)];

  const policy: SymlinkPolicy = {
    followFileSymlinks: options.followFileSymlinks,
    allowExternalSymlinkTargets: options.allowExternalSymlinkTargets,
    pathRewrite: options.pathRewrite,
    boundaryRoots,
  };

  const coveredTargets = new Set<string>();

  if (options.useGitignore && options.allowGit) {
    const discovered = await discoverGitRepos(
      options.workspaceFolder,
      options.targetPaths,
      options.git,
    );

    if (discovered.roots.length > 0) {
      await collectFromGitRepos(options, discovered.roots, policy, out, skippedTreeItems, stats);
      for (const target of discovered.coveredTargets.keys()) {
        coveredTargets.add(target);
      }
    }
  }

  // Filesystem walker for targets not covered by a discovered Git repo (and when Git is off).
  for (const targetPath of options.targetPaths) {
    if (coveredTargets.has(path.resolve(targetPath))) continue;

    const stack = new IgnoreStack();
    if (options.useGitignore) {
      await seedIgnoreStack(stack, options.workspaceFolder, targetPath, options.gitignoreFileName);
    }
    await walkFilesystem({
      filePath: targetPath,
      workspaceFolder: options.workspaceFolder,
      options,
      policy,
      stack,
      out,
      skippedTreeItems,
      stats,
      pushedHere: false,
    });
  }

  return {
    files: dedupeCandidates(out),
    skippedTreeItems,
    stats,
  };
}

async function collectFromGitRepos(
  options: CollectOptions,
  repos: readonly string[],
  policy: SymlinkPolicy,
  out: CollectedFile[],
  skippedTreeItems: TreeEntry[],
  stats: SkipStats,
): Promise<void> {
  const seenAbs = new Set<string>();

  for (const repoRoot of repos) {
    const relevantTargets = options.targetPaths.filter((target) =>
      isPathInsideOrEqual(repoRoot, target),
    );

    if (relevantTargets.length === 0) continue;

    const pathspecs = await targetsToGitPathspecs(relevantTargets, repoRoot);

    // Discovery already marked these targets as Git-owned; never swallow ls-files failures.
    const files = await listGitFiles(repoRoot, pathspecs, options.git, 'tracked-and-visible');

    for (const rel of files) {
      const absolute = path.join(repoRoot, rel);
      if (seenAbs.has(absolute)) continue;
      seenAbs.add(absolute);

      const displayPath = toDisplayPath(options.workspaceFolder, absolute);
      if (
        shouldExclude(displayPath, options.excludes) ||
        shouldExclude(absolute, options.excludes)
      ) {
        markSkipped(stats, 'excluded');
        pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'excluded');
        continue;
      }

      await collectSinglePath({
        filePath: absolute,
        workspaceFolder: options.workspaceFolder,
        options,
        policy,
        out,
        skippedTreeItems,
        stats,
      });
    }
  }
}

async function seedIgnoreStack(
  stack: IgnoreStack,
  workspaceFolder: string,
  targetPath: string,
  fileName: string,
): Promise<void> {
  let dir = targetPath;
  try {
    const st = await fs.lstat(targetPath);
    if (!st.isDirectory()) dir = path.dirname(targetPath);
  } catch {
    dir = path.dirname(targetPath);
  }

  const workspace = path.resolve(workspaceFolder);
  let current = path.resolve(dir);
  const dirs: string[] = [];
  while (isPathInsideOrEqual(workspace, current)) {
    dirs.push(current);
    if (path.resolve(current) === workspace) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const absoluteDir of dirs.reverse()) {
    await pushGitignoreForDir(stack, workspaceFolder, absoluteDir, fileName);
  }
}

interface WalkArgs {
  filePath: string;
  workspaceFolder: string;
  options: CollectOptions;
  policy: SymlinkPolicy;
  stack: IgnoreStack;
  out: CollectedFile[];
  skippedTreeItems: TreeEntry[];
  stats: SkipStats;
  pushedHere: boolean;
}

async function walkFilesystem(args: WalkArgs): Promise<void> {
  const { filePath, workspaceFolder, options, policy, stack, out, skippedTreeItems, stats } = args;
  const displayPath = toDisplayPath(workspaceFolder, filePath);

  if (shouldExclude(displayPath, options.excludes) || shouldExclude(filePath, options.excludes)) {
    markSkipped(stats, 'excluded');
    pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'excluded');
    return;
  }

  let lst;
  try {
    lst = await fs.lstat(filePath);
  } catch {
    markSkipped(stats, 'lstat failed');
    pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'lstat failed');
    return;
  }

  if (options.useGitignore && stack.ignores(displayPath, lst.isDirectory())) {
    markSkipped(stats, 'gitignored');
    pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'gitignored');
    return;
  }

  if (lst.isSymbolicLink()) {
    await collectSymlink({
      filePath,
      displayPath,
      policy,
      options,
      out,
      skippedTreeItems,
      stats,
    });
    return;
  }

  if (lst.isFile()) {
    out.push({
      displayPath,
      sourcePath: filePath,
      readPath: filePath,
      isSymlink: false,
      symlinkTarget: null,
      symlinkNote: '',
    });
    return;
  }

  if (lst.isDirectory()) {
    let pushed = false;
    if (options.useGitignore) {
      if (args.pushedHere) {
        await pushGitignoreForDir(stack, workspaceFolder, filePath, options.gitignoreFileName);
        pushed = true;
      } else {
        args.pushedHere = true;
      }
    }

    let entries;
    try {
      entries = await fs.readdir(filePath, { withFileTypes: true });
    } catch {
      markSkipped(stats, 'directory unreadable');
      pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'directory unreadable');
      if (pushed) stack.pop();
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await walkFilesystem({
        filePath: path.join(filePath, entry.name),
        workspaceFolder,
        options,
        policy,
        stack,
        out,
        skippedTreeItems,
        stats,
        pushedHere: true,
      });
    }
    if (pushed) stack.pop();
    return;
  }

  markSkipped(stats, 'unsupported type');
  pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'unsupported type');
}

async function collectSinglePath(args: {
  filePath: string;
  workspaceFolder: string;
  options: CollectOptions;
  policy: SymlinkPolicy;
  out: CollectedFile[];
  skippedTreeItems: TreeEntry[];
  stats: SkipStats;
}): Promise<void> {
  const { filePath, workspaceFolder, options, policy, out, skippedTreeItems, stats } = args;
  const displayPath = toDisplayPath(workspaceFolder, filePath);

  let lst;
  try {
    lst = await fs.lstat(filePath);
  } catch {
    markSkipped(stats, 'lstat failed');
    pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'lstat failed');
    return;
  }

  if (lst.isSymbolicLink()) {
    await collectSymlink({
      filePath,
      displayPath,
      policy,
      options,
      out,
      skippedTreeItems,
      stats,
    });
    return;
  }

  if (lst.isFile()) {
    out.push({
      displayPath,
      sourcePath: filePath,
      readPath: filePath,
      isSymlink: false,
      symlinkTarget: null,
      symlinkNote: '',
    });
    return;
  }

  markSkipped(stats, 'unsupported type');
}

async function collectSymlink(args: {
  filePath: string;
  displayPath: string;
  policy: SymlinkPolicy;
  options: CollectOptions;
  out: CollectedFile[];
  skippedTreeItems: TreeEntry[];
  stats: SkipStats;
}): Promise<void> {
  const { filePath, displayPath, policy, options, out, skippedTreeItems, stats } = args;

  let symlinkTarget = '(unknown)';
  try {
    symlinkTarget = await fs.readlink(filePath);
  } catch {
    // keep '(unknown)'
  }

  const resolved = await resolveReadablePath(filePath, policy);

  if (resolved.kind === 'file') {
    if (!options.followFileSymlinks) {
      markSkipped(stats, 'file symlink disabled');
      pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'file symlink');
      return;
    }

    if (resolved.external && !options.allowExternalSymlinkTargets) {
      markSkipped(stats, 'external symlink');
      pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'external symlink');
      return;
    }

    out.push({
      displayPath,
      sourcePath: filePath,
      readPath: resolved.readPath!,
      isSymlink: true,
      symlinkTarget,
      symlinkNote: formatSymlinkNote(
        symlinkTarget,
        resolved.readPath!,
        filePath,
        policy.boundaryRoots,
      ),
    });
    return;
  }

  if (resolved.kind === 'directory') {
    markSkipped(stats, 'directory symlink');
    pushSkip(skippedTreeItems, options.includeSkippedInTree, displayPath, 'directory symlink');
    return;
  }

  markSkipped(stats, resolved.reason || 'broken symlink');
  pushSkip(
    skippedTreeItems,
    options.includeSkippedInTree,
    displayPath,
    resolved.reason || 'broken symlink',
  );
}

function dedupeCandidates(items: CollectedFile[]): CollectedFile[] {
  const map = new Map<string, CollectedFile>();
  for (const item of items) {
    if (!map.has(item.displayPath)) {
      map.set(item.displayPath, item);
    }
  }
  return [...map.values()];
}

export { toPosixPath };
