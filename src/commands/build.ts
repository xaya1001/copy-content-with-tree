import * as fs from 'node:fs/promises';
import { isProbablyBinary } from '../core/binary';
import { mergeExcludes, type ExtensionConfig } from '../core/config';
import { assertWithinOutputLimit, formatReasons, OutputLimitError } from '../core/output';
import { escapePathForDisplay } from '../core/paths';
import { makeTree, sortTreeEntries, type TreeEntry } from '../core/tree';
import { collectFiles, type CollectOptions } from '../fs/walk';
import type { GitExecConfig } from '../git/discovery';
import { buildGitDiff, EmptyDiffError } from '../git/diff';

export interface CommandTarget {
  fsPath: string;
}

export interface BuildContext {
  workspaceFolder: string;
  targets: CommandTarget[];
  config: ExtensionConfig;
  /** True only in trusted workspaces; gates all Git subprocess usage. */
  allowGit: boolean;
  signal?: AbortSignal;
}

function toCollectOptions(ctx: BuildContext): CollectOptions {
  const git: GitExecConfig = {
    timeoutMs: ctx.config.gitTimeoutMs,
    maxBufferBytes: ctx.config.gitMaxBufferBytes,
    signal: ctx.signal,
  };

  return {
    workspaceFolder: ctx.workspaceFolder,
    targetPaths: ctx.targets.map((t) => t.fsPath),
    excludes: mergeExcludes(ctx.config.exclude, ctx.config.blacklist),
    useGitignore: ctx.config.useGitignore,
    allowGit: ctx.allowGit,
    gitignoreFileName: ctx.config.gitignoreFileName,
    includeSkippedInTree: ctx.config.includeSkippedInTree,
    followFileSymlinks: ctx.config.followFileSymlinks,
    allowExternalSymlinkTargets: ctx.config.allowExternalSymlinkTargets,
    pathRewrite: ctx.config.pathRewrite,
    git,
  };
}

export interface TreeCopyResult {
  output: string;
  pathCount: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

export async function buildCopyTree(ctx: BuildContext): Promise<TreeCopyResult> {
  const collected = await collectFiles(toCollectOptions(ctx));
  const entries = sortTreeEntries([
    ...collected.files.map((item) => ({ path: item.displayPath })),
    ...collected.skippedTreeItems,
  ]);

  if (entries.length === 0) {
    const reasonText = formatReasons(collected.stats.skippedReasons);
    const suffix = reasonText ? ` Reasons: ${reasonText}` : '';
    throw new NothingCopiedError(
      `Copy Tree: nothing copied. Skipped ${collected.stats.skipped}.${suffix}`,
    );
  }

  const output = `### tree\n${makeTree(entries)}`;
  assertWithinOutputLimit(
    output.length,
    ctx.config.maxOutputChars,
    `Copy Tree: output too large (${output.length.toLocaleString()} chars). ` +
      `Select fewer paths or raise copyContentWithTree.maxOutputChars.`,
  );

  return {
    output,
    pathCount: entries.length,
    skipped: collected.stats.skipped,
    skippedReasons: collected.stats.skippedReasons,
  };
}

export interface ContentCopyResult {
  output: string;
  fileCount: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

export async function buildCopyContent(ctx: BuildContext): Promise<ContentCopyResult> {
  const collected = await collectFiles(toCollectOptions(ctx));
  const uniqueFiles = [...collected.files].sort((a, b) =>
    a.displayPath.localeCompare(b.displayPath),
  );
  const copiedEntries: TreeEntry[] = [];
  const treeOnlyEntries: TreeEntry[] = [...collected.skippedTreeItems];
  const blocks: string[] = [];
  let blockChars = 0;
  const stats = collected.stats;

  for (const item of uniqueFiles) {
    try {
      const stat = await fs.stat(item.readPath);
      if (!stat.isFile()) {
        markLocalSkip(stats, 'not a regular file', treeOnlyEntries, item.displayPath, ctx);
        continue;
      }

      if (stat.size > ctx.config.maxFileSizeKB * 1024) {
        markLocalSkip(stats, 'too large', treeOnlyEntries, item.displayPath, ctx);
        continue;
      }

      const buffer = await fs.readFile(item.readPath);
      if (isProbablyBinary(buffer)) {
        markLocalSkip(stats, 'binary', treeOnlyEntries, item.displayPath, ctx);
        continue;
      }

      copiedEntries.push({ path: item.displayPath });
      const symlinkNote = item.isSymlink ? item.symlinkNote : '';
      const headerPath = escapePathForDisplay(item.displayPath);
      const block = `### ${headerPath}${symlinkNote}\n${buffer.toString('utf8')}`;
      blockChars += block.length + 2;
      assertWithinOutputLimit(
        blockChars,
        ctx.config.maxOutputChars,
        `Copy Content with Tree: output too large before clipboard write (${blockChars.toLocaleString()} chars). ` +
          `Select fewer files, add blacklist/.gitignore rules, or raise copyContentWithTree.maxOutputChars.`,
      );
      blocks.push(block);
    } catch (err) {
      if (err instanceof OutputLimitError) throw err;
      markLocalSkip(stats, 'unreadable', treeOnlyEntries, item.displayPath, ctx);
    }
  }

  if (blocks.length === 0) {
    const reasonText = formatReasons(stats.skippedReasons);
    const suffix = reasonText ? ` Reasons: ${reasonText}` : '';
    throw new NothingCopiedError(
      `Copy Content with Tree: nothing copied. Candidates ${uniqueFiles.length}, skipped ${stats.skipped}.${suffix}`,
    );
  }

  const tree = makeTree(sortTreeEntries([...copiedEntries, ...treeOnlyEntries]));
  const estimated = `### tree\n${tree}`.length + blockChars + Math.max(0, blocks.length) * 2;
  assertWithinOutputLimit(
    estimated,
    ctx.config.maxOutputChars,
    `Copy Content with Tree: output too large before clipboard write (${estimated.toLocaleString()} chars). ` +
      `Select fewer files, add blacklist/.gitignore rules, or raise copyContentWithTree.maxOutputChars.`,
  );

  const output = [`### tree\n${tree}`, ...blocks].join('\n\n');
  assertWithinOutputLimit(
    output.length,
    ctx.config.maxOutputChars,
    `Copy Content with Tree: output too large (${output.length.toLocaleString()} chars). ` +
      `Select fewer files, add blacklist/.gitignore rules, or raise copyContentWithTree.maxOutputChars.`,
  );

  return {
    output,
    fileCount: blocks.length,
    skipped: stats.skipped,
    skippedReasons: stats.skippedReasons,
  };
}

function markLocalSkip(
  stats: { skipped: number; skippedReasons: Record<string, number> },
  reason: string,
  treeOnlyEntries: TreeEntry[],
  displayPath: string,
  ctx: BuildContext,
): void {
  stats.skipped++;
  stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
  if (ctx.config.includeSkippedInTree) {
    treeOnlyEntries.push({ path: displayPath, comment: `skipped: ${reason}` });
  }
}

export interface DiffCopyResult {
  output: string;
  fileCount: number;
  filteredCount: number;
  upstream: string;
}

export async function buildCopyDiff(ctx: BuildContext): Promise<DiffCopyResult> {
  if (!ctx.allowGit) {
    throw new Error(
      'Copy Git Diff with Tree requires a trusted workspace. Trust this folder to run Git operations.',
    );
  }

  const result = await buildGitDiff({
    workspaceFolder: ctx.workspaceFolder,
    targetPaths: ctx.targets.map((t) => t.fsPath),
    autoFetch: ctx.config.diffAutoFetch,
    includeUntracked: ctx.config.diffIncludeUntracked,
    unifiedLines: ctx.config.diffUnifiedLines,
    excludes: mergeExcludes(ctx.config.exclude, ctx.config.blacklist),
    useGitignore: ctx.config.useGitignore,
    gitignoreFileName: ctx.config.gitignoreFileName,
    git: {
      timeoutMs: ctx.config.gitTimeoutMs,
      maxBufferBytes: ctx.config.gitMaxBufferBytes,
      signal: ctx.signal,
    },
  });

  assertWithinOutputLimit(
    result.output.length,
    ctx.config.maxOutputChars,
    `Copy Content with Tree: diff output too large (${result.output.length.toLocaleString()} chars). ` +
      `Select fewer paths or raise copyContentWithTree.maxOutputChars.`,
  );

  return {
    output: result.output,
    fileCount: result.fileCount,
    filteredCount: result.filteredCount,
    upstream: result.upstream,
  };
}

export class NothingCopiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NothingCopiedError';
  }
}

export { EmptyDiffError, OutputLimitError, formatReasons };
