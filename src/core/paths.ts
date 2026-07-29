import * as path from 'node:path';

/**
 * Normalize path separators for matching/display.
 * On Windows, convert `\` to `/`. On POSIX, leave `\` intact — it is a legal
 * filename byte and must not be treated as a directory separator.
 */
export function toPosixPath(value: string): string {
  const text = String(value);
  if (process.platform === 'win32') {
    return text.replace(/\\/g, '/');
  }
  return text;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function stripLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

/** Workspace-relative display path. Never returns an absolute host path. */
export function toDisplayPath(workspaceFolder: string, filePath: string): string {
  const relative = path.relative(workspaceFolder, filePath);
  if (!relative || relative === '') {
    return path.basename(filePath);
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return path.basename(filePath);
  }
  return toPosixPath(relative);
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || path.isAbsolute(relative)) return false;
  // Component-aware: only treat ".." / "../..." as outside. Names like "..foo" are inside.
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** True when candidate is root itself or a contained path (component-aware). */
export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedRoot === resolvedCandidate || isPathInside(root, candidate);
}

export function rewritePath(
  inputPath: string,
  fromPrefix: string,
  toPrefix: string,
): string | null {
  const p = toPosixPath(inputPath);
  const from = trimTrailingSlash(toPosixPath(fromPrefix || ''));
  const to = trimTrailingSlash(toPosixPath(toPrefix || ''));
  if (!from || !to) return null;
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return null;
}

export function buildRewriteCandidates(
  absTarget: string,
  pathRewrite: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  const candidates = [toPosixPath(absTarget)];
  const rules = [...pathRewrite].sort((a, b) => b.from.length - a.from.length);
  for (const rule of rules) {
    const rewritten = rewritePath(absTarget, rule.from, rule.to);
    if (rewritten && !candidates.includes(rewritten)) {
      candidates.push(rewritten);
    }
  }
  return candidates;
}

/** Prefer a workspace-relative path for clipboard metadata; never emit raw absolute paths. */
export function toSafePathLabel(absoluteOrRelative: string, roots: readonly string[]): string {
  const posix = toPosixPath(absoluteOrRelative);
  if (!path.isAbsolute(absoluteOrRelative) && !posix.startsWith('/')) {
    return escapePathForDisplay(posix);
  }

  for (const root of roots) {
    if (
      isPathInside(root, absoluteOrRelative) ||
      path.resolve(root) === path.resolve(absoluteOrRelative)
    ) {
      const relative = toPosixPath(path.relative(root, absoluteOrRelative));
      if (relative && !relative.startsWith('../') && relative !== '..') {
        return escapePathForDisplay(relative || '.');
      }
      if (relative === '') return '.';
    }
  }

  return escapePathForDisplay(path.posix.basename(posix) || '(external)');
}

/**
 * Escape control characters for tree lines and content headers.
 * Does not alter the underlying filesystem / Git path used for I/O.
 */
export function escapePathForDisplay(value: string): string {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}
