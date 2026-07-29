import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  GitCommandError,
  GitNotFoundError,
  isCancellationError,
  parseNulPaths,
  runGit,
  type GitRunOptions,
} from './exec';

export interface GitExecConfig {
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
}

function toRunOptions(cwd: string, config: GitExecConfig): GitRunOptions {
  return {
    cwd,
    timeoutMs: config.timeoutMs,
    maxBufferBytes: config.maxBufferBytes,
    signal: config.signal,
  };
}

function isNotAGitRepositoryError(err: unknown): boolean {
  if (!(err instanceof GitCommandError)) return false;
  const detail = `${err.stderr}\n${err.stdout}\n${err.message}`.toLowerCase();
  return (
    detail.includes('not a git repository') ||
    detail.includes('outside repository') ||
    detail.includes('does not have a commit checked out')
  );
}

/**
 * Resolve the Git repo root for cwd.
 * Returns null only when Git reports the path is not inside a repository.
 * Propagates Git-not-found, cancellation, timeout, and other failures.
 */
export async function getRepoRoot(cwd: string, config: GitExecConfig): Promise<string | null> {
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], toRunOptions(cwd, config));
    const root = result.stdout.toString('utf8').replace(/\0/g, '').trim();
    return root || null;
  } catch (err) {
    if (isCancellationError(err)) throw err;
    if (err instanceof GitNotFoundError) throw err;
    if (isNotAGitRepositoryError(err)) return null;
    throw err;
  }
}

export async function discoveryCwdForTarget(targetPath: string): Promise<string> {
  try {
    const stat = await fs.lstat(targetPath);
    return stat.isDirectory() ? targetPath : path.dirname(targetPath);
  } catch {
    return path.dirname(targetPath);
  }
}

/**
 * Discover Git repositories that cover the selection.
 * Only walks upward from each selected target (and optionally the workspace folder
 * when no target yields a repo). Does not recursively scan for nested repos under
 * a selected directory.
 *
 * Returns both the unique repo roots and which selected targets are covered by a repo.
 */
export async function discoverGitRepos(
  workspaceFolder: string,
  targetPaths: readonly string[],
  config: GitExecConfig,
): Promise<{ roots: string[]; coveredTargets: Map<string, string> }> {
  const coveredTargets = new Map<string, string>();
  const roots = new Set<string>();

  for (const targetPath of targetPaths) {
    const cwd = await discoveryCwdForTarget(targetPath);
    const root = await getRepoRoot(cwd, config);
    if (root) {
      const resolved = path.resolve(root);
      roots.add(resolved);
      coveredTargets.set(path.resolve(targetPath), resolved);
    }
  }

  if (roots.size === 0 && targetPaths.length === 0) {
    const root = await getRepoRoot(workspaceFolder, config);
    if (root) roots.add(path.resolve(root));
  }

  return {
    roots: [...roots].sort((a, b) => a.localeCompare(b)),
    coveredTargets,
  };
}

export async function targetsToGitPathspecs(
  targets: readonly string[],
  repoRoot: string,
): Promise<string[]> {
  const pathspecs: string[] = [];

  for (const targetPath of targets) {
    const relative = path.relative(repoRoot, targetPath);
    if (!relative || relative === '') return [];
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`selected path is outside the Git repository: ${targetPath}`);
    }
    const posix = relative.split(path.sep).join('/');
    if (!pathspecs.includes(posix)) pathspecs.push(posix);
  }

  return pathspecs;
}

/**
 * Always wrap a raw repo-relative path for pathspec magic.
 * Never treat an existing `:(literal)` prefix as already-wrapped: a real filename
 * can literally be `:(literal)foo`, and returning it unchanged would target `foo`.
 * Prefer {@link withLiteralPathspecs} for Git invocations (including `--no-index`).
 */
export function toLiteralPathspec(repoRelativePosix: string): string {
  return `:(literal)${repoRelativePosix}`;
}

/** Prepend Git's global option so every pathspec on the command is treated literally. */
export function withLiteralPathspecs(commandArgs: readonly string[]): string[] {
  return ['--literal-pathspecs', ...commandArgs];
}

/** Build `['--', rawPath, …]` or `[]` when selecting the whole repo. Paths stay raw. */
export function pathspecArgs(repoRelativePaths: readonly string[]): string[] {
  if (repoRelativePaths.length === 0) return [];
  return ['--', ...repoRelativePaths];
}

export async function listGitFiles(
  repoRoot: string,
  pathspecs: readonly string[],
  config: GitExecConfig,
  mode: 'tracked-and-visible' | 'tracked-only' | 'untracked-visible',
): Promise<string[]> {
  const args = ['ls-files', '-z'];
  if (mode === 'tracked-and-visible') {
    args.push('--cached', '--others', '--exclude-standard');
  } else if (mode === 'tracked-only') {
    args.push('--cached');
  } else {
    args.push('--others', '--exclude-standard');
  }

  args.push(...pathspecArgs(pathspecs));

  const result = await runGit(withLiteralPathspecs(args), toRunOptions(repoRoot, config));
  return parseNulPaths(result.stdout);
}
