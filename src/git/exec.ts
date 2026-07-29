import { spawn } from 'node:child_process';

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  allowedExitCodes?: readonly number[];
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Grace period after SIGTERM before SIGKILL on timeout/cancel. */
  killGraceMs?: number;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly args: readonly string[];

  constructor(
    message: string,
    args: readonly string[],
    exitCode: number,
    stdout: Buffer,
    stderr: Buffer,
  ) {
    super(message);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout.toString('utf8');
    this.stderr = stderr.toString('utf8');
  }
}

export class GitNotFoundError extends Error {
  constructor(message = 'Git was not found on PATH. Install Git and retry.') {
    super(message);
    this.name = 'GitNotFoundError';
  }
}

export class OperationCancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

export function isCancellationError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof OperationCancelledError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof GitCommandError && /cancelled/i.test(err.message)) return true;
  return false;
}

export async function runGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? 64 * 1024 * 1024;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const allowed = new Set(options.allowedExitCodes ?? [0]);

  if (options.signal?.aborted) {
    throw new OperationCancelledError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn('git', args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const forceKill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    };

    const softKillThenForce = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(forceKill, killGraceMs);
    };

    const onAbort = (): void => {
      cancelled = true;
      softKillThenForce();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            softKillThenForce();
          }, timeoutMs)
        : undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (result: GitRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        fail(new GitNotFoundError());
        return;
      }
      fail(err);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxBufferBytes) {
        fail(
          new GitCommandError(
            `Git output exceeded maxBufferBytes (${maxBufferBytes}).`,
            args,
            -1,
            Buffer.concat(stdoutChunks),
            Buffer.concat(stderrChunks),
          ),
        );
        softKillThenForce();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > maxBufferBytes) {
        fail(
          new GitCommandError(
            `Git stderr exceeded maxBufferBytes (${maxBufferBytes}).`,
            args,
            -1,
            Buffer.concat(stdoutChunks),
            Buffer.concat(stderrChunks),
          ),
        );
        softKillThenForce();
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('close', (code) => {
      const exitCode = code ?? -1;
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);

      if (cancelled || options.signal?.aborted) {
        fail(new OperationCancelledError('Git cancelled.'));
        return;
      }

      if (timedOut) {
        fail(
          new GitCommandError(
            `Git timed out after ${timeoutMs}ms.`,
            args,
            exitCode,
            stdout,
            stderr,
          ),
        );
        return;
      }

      if (!allowed.has(exitCode)) {
        const detail = stderr.toString('utf8').trim() || stdout.toString('utf8').trim();
        fail(
          new GitCommandError(
            detail || `Git exited with code ${exitCode}.`,
            args,
            exitCode,
            stdout,
            stderr,
          ),
        );
        return;
      }

      succeed({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Split NUL-delimited Git path lists.
 * Preserves every character inside each entry (spaces, tabs, newlines, CR).
 * Does not trim. Only drops empty segments created by a trailing/leading NUL.
 */
export function parseNulPaths(buffer: Buffer | string): string[] {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  if (text.length === 0) return [];

  const parts = text.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.filter((entry) => entry.length > 0);
}

export interface GitNameStatusEntry {
  status: string;
  path: string;
  oldPath: string | null;
}

export function parseNameStatusNul(buffer: Buffer | string): GitNameStatusEntry[] {
  const parts = parseNulPaths(buffer);
  const entries: GitNameStatusEntry[] = [];

  for (let i = 0; i < parts.length;) {
    const status = parts[i++] ?? '';
    if (!status) continue;

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++] ?? '';
      const newPath = parts[i++] ?? '';
      if (newPath) {
        entries.push({ status, path: newPath, oldPath: oldPath || null });
      }
      continue;
    }

    const filePath = parts[i++] ?? '';
    if (filePath) {
      entries.push({ status, path: filePath, oldPath: null });
    }
  }

  return entries;
}

export function formatGitUserError(err: unknown): string {
  if (err instanceof GitNotFoundError) {
    return err.message;
  }

  if (err instanceof GitCommandError) {
    const detail = (err.stderr || err.stdout || err.message).trim();
    const lower = detail.toLowerCase();

    if (lower.includes('no upstream') || lower.includes('no upstream configured')) {
      return (
        'No upstream branch is configured for the current branch. ' +
        'Set upstream with `git push -u` or `git branch -u`, then retry.'
      );
    }

    if (lower.includes('needed a single revision') || lower.includes('ambiguous argument')) {
      return (
        'Unable to resolve upstream or merge-base. ' +
        'Ensure the branch has an upstream and is not in an unexpected detached state.'
      );
    }

    if (lower.includes('not a git repository')) {
      return 'Selected path is not inside a Git repository.';
    }

    if (lower.includes('detached') && lower.includes('head')) {
      return 'HEAD is detached and has no upstream. Check out a branch with an upstream, then retry.';
    }

    return detail || err.message;
  }

  if (err instanceof Error) return err.message;
  return String(err);
}
